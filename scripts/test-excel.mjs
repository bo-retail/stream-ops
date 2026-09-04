/**
 * Verifies the schedule Excel export: that it is authorised correctly, that the
 * bytes really are a valid workbook, and that the sheets contain what they
 * should. Downloading a file that opens as corrupt would otherwise only be
 * discovered by the person trying to use it.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { SignJWT } from "jose";
import { Client } from "pg";

const BASE = process.argv[2] ?? "http://localhost:3000";
const secret = new TextEncoder().encode(process.env.AUTH_SECRET);

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const { rows: users } = await db.query(
  `select id, email, name, role from "User" where "isActive" order by role`,
);
// A release with people actually on it. An empty one would prove nothing.
const { rows: weeks } = await db.query(
  `select w.id, count(a.id)::int as assignments, count(distinct s.id)::int as shows,
          (w."endDate" - w."startDate" + 1) as days
   from "Release" w
   join "Show" s on s."releaseId" = w.id
   left join "Assignment" a on a."showId" = s.id
   group by w.id
   having count(a.id) > 0
   order by max(s.date) desc limit 1`,
);
if (weeks.length === 0) {
  console.log("SKIP  no release has anyone assigned. Build a schedule, then run this again.");
  await db.end();
  process.exit(0);
}
await db.end();

const boss = users.find((u) => u.role === "BOSS");
const employee = users.find((u) => u.role === "EMPLOYEE");
const week = weeks[0].id;
const showCount = weeks[0].shows;
const dayCount = weeks[0].days;

async function cookieFor(user) {
  const token = await new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(new Date(Date.now() + 3_600_000))
    .sign(secret);
  return `streamops_session=${token}`;
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const url = `${BASE}/api/schedule/export?release=${week}`;

const anon = await fetch(url, { redirect: "manual" });
check("rejects anonymous", anon.status === 401 || anon.status === 307, `status ${anon.status}`);

const emp = await fetch(url, { headers: { cookie: await cookieFor(employee) }, redirect: "manual" });
check("rejects employees", emp.status === 403, `status ${emp.status}`);

const bad = await fetch(`${BASE}/api/schedule/export?release=nonsense`, {
  headers: { cookie: await cookieFor(boss) },
});
check("rejects an unknown release", bad.status === 404, `status ${bad.status}`);

const res = await fetch(url, { headers: { cookie: await cookieFor(boss) } });
check("boss can download", res.status === 200, `status ${res.status}`);
check(
  "served as an xlsx attachment",
  (res.headers.get("content-type") ?? "").includes("spreadsheetml") &&
    (res.headers.get("content-disposition") ?? "").includes(".xlsx"),
);

const buffer = Buffer.from(await res.arrayBuffer());
check("file is not empty", buffer.length > 5000, `${buffer.length} bytes`);

// The real test: can a spreadsheet reader actually open it?
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buffer);
const names = wb.worksheets.map((w) => w.name);
check("opens as a valid workbook", names.length === 3, names.join(", "));
check(
  "has the three expected sheets",
  ["Schedule", "Shows", "Per person"].every((n) => names.includes(n)),
  names.join(", "),
);

const grid = wb.getWorksheet("Schedule");
check("grid has a title row", String(grid.getCell("A1").value ?? "").includes("Schedule —"));
// Four header rows, then one row per day the release covers.
check(
  "grid has a row for every day of the release",
  grid.rowCount === dayCount + 4,
  `${grid.rowCount - 4} day rows for a ${dayCount}-day release`,
);
check(
  "grid names both platforms across the top",
  ["TikTok", "eBay"].every((p) =>
    grid
      .getRow(3)
      .values.map((v) => String(v ?? ""))
      .includes(p),
  ),
);

const shows = wb.getWorksheet("Shows");
// However many shows this release actually has, plus the header row. A release
// is whatever the boss composed, so a fixed number would be wrong by design.
check(
  "shows sheet has a row per show",
  shows.rowCount === showCount + 1,
  `${shows.rowCount - 1} rows for ${showCount} shows`,
);
check(
  "shows sheet names both seats",
  ["Person 1", "Person 2"].every((h) =>
    shows
      .getRow(1)
      .values.map((v) => String(v ?? ""))
      .includes(h),
  ),
  shows.getRow(1).values.slice(1).join(", "),
);

// The two people are interchangeable, so the export must not imply a job.
const headerText = shows.getRow(1).values.join(" ");
check(
  "shows sheet does not name a job",
  !/Streamer|Computer/i.test(headerText),
  headerText.trim(),
);

// Column keys are not saved in the file, so read by position:
// 1 date, 2 platform, 3 show, 4 start, 5 end, 6 hours, 7 person 1, 8 person 2, 9 status.
const COL = { person1: 7, person2: 8, status: 9 };

let running = 0;
let namedBoth = 0;
let emptySeats = 0;
for (let r = 2; r <= shows.rowCount; r++) {
  const row = shows.getRow(r);
  if (String(row.getCell(COL.status).value) !== "Running") continue;
  running++;
  const first = String(row.getCell(COL.person1).value ?? "");
  const second = String(row.getCell(COL.person2).value ?? "");
  if (first === "NOBODY" || second === "NOBODY") emptySeats++;
  else if (first && second && first !== second) namedBoth++;
}
// An open seat is allowed — the boss publishes what he has and fills it after
// talking to people — so this reports rather than fails. What it must never do
// is put the same name in both seats, which is checked above by first !== second.
check(
  "no show names the same person twice",
  namedBoth + emptySeats === running,
  `${namedBoth} fully staffed, ${emptySeats} with an open seat, of ${running}`,
);

const per = wb.getWorksheet("Per person");
check("per-person sheet has data", per.rowCount > 1, `${per.rowCount} rows`);
check(
  "per-person sheet ends with a total",
  String(per.getRow(per.rowCount).getCell(1).value) === "TOTAL",
);

const out = "schedule-export-test.xlsx";
writeFileSync(out, buffer);
console.log(`\nsaved a copy to ${out} (${(buffer.length / 1024).toFixed(1)} KB)`);
console.log(failures === 0 ? "All Excel checks passed." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

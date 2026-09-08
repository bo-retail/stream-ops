/**
 * Fetches an employee's own pages and checks what they actually show.
 *
 * Also verifies the boundary that matters most: an employee's schedule page
 * must contain their own shows and must not leak anyone else's assignments.
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { Client } from "pg";

const BASE = process.argv[2] ?? "http://localhost:3000";
const secret = new TextEncoder().encode(process.env.AUTH_SECRET);

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const { rows: users } = await db.query(
  `select id, email, name from "User" where role = 'EMPLOYEE' and "isActive" and team = 'STREAMING' order by name`,
);

// The published week, and what this person is actually on.
const { rows: weeks } = await db.query(
  `select "startDate", "endDate" from "Release" where "scheduleStatus" = 'PUBLISHED' order by "startDate" desc limit 1`,
);
if (weeks.length === 0) {
  console.log(
    "SKIP  no published schedule to read. Publish a release, then run this again.",
  );
  await db.end();
  process.exit(0);
}
const period = weeks[0];
const week = period.startDate.toISOString().slice(0, 10);

const me = users[0];
const { rows: mine } = await db.query(
  `select s.date, s.platform, s.slot,
          (select u2.name from "Assignment" a2 join "User" u2 on u2.id = a2."userId"
            where a2."showId" = s.id and a2."userId" <> $1 limit 1) as partner
   from "Assignment" a
   join "Show" s on s.id = a."showId"
   join "Release" p on p.id = s."releaseId"
   where a."userId" = $1 and p."startDate" = $2
   order by s."startsAt"`,
  [me.id, period.startDate],
);

await db.end();

async function cookieFor(user) {
  const token = await new SignJWT({ email: user.email, name: user.name, role: "EMPLOYEE" })
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

const cookie = await cookieFor(me);
const res = await fetch(`${BASE}/schedule?period=${week}`, { headers: { cookie } });
const html = await res.text();
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

console.log(`Signed in as ${me.name}, week of ${week}\n`);
console.log(`They are on ${mine.length} show(s):`);
for (const s of mine) {
  console.log(
    `  ${s.date.toISOString().slice(0, 10)} ${s.platform} ${s.slot}, with ${s.partner ?? "nobody"}`,
  );
}
console.log();

check("page loads", res.status === 200, `status ${res.status}`);
check("shows the week's show count", text.includes(String(mine.length)), `expected ${mine.length}`);

// Their own partners must appear; that is the point of the "With" column.
const partners = [...new Set(mine.map((s) => s.partner).filter(Boolean))];
for (const partner of partners.slice(0, 3)) {
  check(`names their partner ${partner}`, text.includes(partner));
}

// Nobody unrelated may appear. Anyone who never shares a show with them is a leak.
const others = users.filter((u) => u.id !== me.id && !partners.includes(u.name));
const leaked = others.filter((u) => text.includes(u.name));
check(
  "does not leak colleagues they do not work with",
  leaked.length === 0,
  leaked.length ? leaked.map((u) => u.name).join(", ") : "none",
);

// A draft week must stay invisible.
const { status } = await fetch(`${BASE}/schedule?period=2099-01-04`, { headers: { cookie } });
const draftHtml = await (await fetch(`${BASE}/schedule?period=2099-01-04`, { headers: { cookie } })).text();
check(
  "an unpublished week says so rather than showing shifts",
  draftHtml.includes("Not published yet"),
  `status ${status}`,
);

// The dashboard's "Your next shows" must list each show exactly once.
//
// It used to be assembled by asking for "this week" and "next week" and gluing
// the two answers together. Those are week dates, but they get snapped to
// half-month periods — so whenever both fell in the same half of the month the
// same period came back twice and every show appeared twice. It is read forward
// by date now. This guards that, and it is worth asserting rather than
// eyeballing because it only went wrong on about half the dates in a month.
const dashHtml = await (await fetch(`${BASE}/dashboard`, { headers: { cookie } })).text();
const rows = [
  ...dashHtml.matchAll(/<li class="flex items-center justify-between gap-3 px-4 py-2\.5"[\s\S]*?<\/li>/g),
].map((m) => m[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
const distinct = new Set(rows);
check(
  "the dashboard lists each upcoming show once",
  rows.length === distinct.size,
  `${rows.length} row(s), ${distinct.size} distinct`,
);

console.log(failures === 0 ? "\nAll employee-view checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

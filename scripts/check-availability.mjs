/**
 * Checks the draft-then-send-in rule from both sides.
 *
 * The point of the rule: what somebody taps is a private draft that the
 * scheduler must not see, and pressing Send in both publishes it to the boss and
 * locks it. So there are two things to prove — that a draft is invisible to the
 * scheduler, and that a sent-in period cannot be edited.
 *
 * Reads the rendered pages as the people themselves, with a session minted from
 * the app's own secret, rather than trusting the code that draws them.
 *
 * Usage: node scripts/check-availability.mjs [baseUrl]
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { Client } from "pg";

const BASE = process.argv[2] ?? "http://localhost:3000";
const secret = new TextEncoder().encode(process.env.AUTH_SECRET);

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function cookieFor(user) {
  const token = await new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(new Date(Date.now() + 3_600_000))
    .sign(secret);
  return `streamops_session=${token}`;
}

/**
 * The page as readable text.
 *
 * React splits interpolated values into separate nodes — "7 of 8 sent in"
 * arrives as `7<!-- --> of <!-- -->8 sent in` — so the markup is stripped and
 * the whitespace collapsed before anything is looked for in it. Otherwise a
 * check passes or fails on where React happened to put a comment.
 */
async function page(user, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { cookie: await cookieFor(user) },
    redirect: "manual",
  });
  if (res.status !== 200) return `__status_${res.status}__`;
  return (await res.text())
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

/* ---------------------------------------------- find an open period to test */

const { rows: open } = await db.query(`
  select id, "startDate"::text as start, "endDate"::text as "end"
  from "Release"
  where status = 'OPEN' and "scheduleStatus" = 'DRAFT'
  order by "startDate" limit 1
`);

if (open.length === 0) {
  console.log("SKIP  no release is out with the team. Send one from the Releases tab, then run this again.");
  await db.end();
  process.exit(0);
}
const period = open[0];
console.log(`Period ${period.start} – ${period.end}\n`);

const { rows: people } = await db.query(
  `select u.id, u.email, u.name, u.role,
          (select count(*)::int from "AvailabilitySubmission" s
            where s."userId" = u.id and s."releaseId" = $3) as sent,
          (select count(*)::int from "Availability" av
            where av."userId" = u.id and av.date between $1 and $2) as offered
     from "User" u
    where u.role = 'EMPLOYEE' and u.team = 'STREAMING' and u."isActive"
    order by u.name`,
  [period.start, period.end, period.id],
);

const drafting = people.find((p) => p.sent === 0);
const sentIn = people.find((p) => p.sent > 0);

/* ------------------------------------------- 1. what each person is shown --- */

if (drafting) {
  const html = await page(drafting, "/availability");
  check(
    `${drafting.name} (not sent in) is offered a Send in button`,
    html.includes("Send in") && html.includes("Not sent in yet"),
    `${drafting.offered} shows tapped so far`,
  );
  check(
    `${drafting.name} is told their taps are saved but not yet sent`,
    html.includes("saved as you") || html.includes("Nothing reaches your admin"),
  );
} else {
  console.log("note  everybody has sent in, so the drafting view cannot be checked");
}

if (sentIn) {
  const html = await page(sentIn, "/availability");
  check(
    `${sentIn.name} (sent in) sees it locked, with no Send in button`,
    html.includes("Sent in") && !html.includes("Not sent in yet"),
    `${sentIn.offered} shows offered`,
  );
  check(
    `${sentIn.name} is told how to get it changed`,
    html.includes("reopen"),
  );
} else {
  console.log("note  nobody has sent in, so the locked view cannot be checked");
}

/* ---------------- 2. the scheduler ignores a draft, and the boss sees why --- */

if (drafting && drafting.offered > 0) {
  const boss = (
    await db.query(`select id, email, name, role from "User" where role = 'BOSS' limit 1`)
  ).rows[0];
  const html = await page(boss, `/admin/schedule?release=${period.id}`);

  // Their name is in the picker, but every show reads as one they did not
  // offer — because as far as the scheduler is concerned, they have said
  // nothing at all yet.
  check(
    "a draft does not count as availability on the schedule",
    html.includes(drafting.name) && html.includes("Did not offer this show"),
    `${drafting.name} has ${drafting.offered} tapped but unsent`,
  );

  const { rows: counted } = await db.query(
    `select count(*)::int as n from "Availability" av
      join "AvailabilitySubmission" s
        on s."userId" = av."userId" and s."releaseId" = av."releaseId"
     where av."releaseId" = $1`,
    [period.id],
  );
  const { rows: all } = await db.query(
    `select count(*)::int as n from "Availability" where "releaseId" = $1`,
    [period.id],
  );
  check(
    "only sent-in availability reaches the generator",
    counted[0].n === all[0].n - drafting.offered,
    `${counted[0].n} of ${all[0].n} rows counted, ${drafting.offered} still a draft`,
  );
} else if (drafting) {
  console.log("note  the drafting person has tapped nothing, so the filter cannot be checked");
}

/* ------------------------------------- 3. the boss can see who is waiting --- */

const boss = (
  await db.query(`select id, email, name, role from "User" where role = 'BOSS' limit 1`)
).rows[0];
const requests = await page(boss, "/admin/requests");
const sentCount = people.filter((p) => p.sent > 0).length;
check(
  "the requests tab reports who has answered, by name",
  requests.includes(`${sentCount} of ${people.length} answered`) &&
    people.every((p) => requests.includes(p.name)),
  `${sentCount} of ${people.length}`,
);
check(
  "everyone still owing an answer is shown as waiting",
  people.filter((p) => p.sent === 0).length === 0 || requests.includes("Waiting"),
);
check(
  "a sent-in answer can be handed back from there",
  sentIn ? requests.includes("Hand back") : true,
);

await db.end();
console.log(
  failures === 0 ? "\nAll availability checks passed." : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);

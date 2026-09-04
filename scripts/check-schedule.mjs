/**
 * Checks the schedule data against the rules the app claims to enforce, in SQL
 * rather than through the domain code — so a bug in the validator cannot hide a
 * bug in the data, or the other way round.
 */
import "dotenv/config";
import { Client } from "pg";

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const { rows: counts } = await db.query(`
  select
    (select count(*) from "Release")::int as periods,
    (select count(*) from "Show")::int as shows,
    (select count(*) from "Show" where status = 'CANCELLED')::int as cancelled,
    (select count(*) from "Assignment")::int as assignments,
    (select count(*) from "Availability")::int as availability,
    (select count(*) from "User" where "isActive")::int as users
`);
console.log("Counts:", counts[0], "\n");

// How many shows each release carries.
//
// Deliberately NOT "four a day": the boss composes each release himself, so two
// days of nights only is a correct release, not a broken one. What is still an
// invariant is the ceiling — four is every platform and slot there is, so more
// than four on a day means something has gone wrong.
const { rows: perRelease } = await db.query(`
  select p."startDate", p."endDate", count(s.id)::int as shows
  from "Release" p left join "Show" s on s."releaseId" = p.id
  group by p."startDate", p."endDate" order by p."startDate"
`);
for (const p of perRelease) {
  const start = p.startDate.toISOString().slice(0, 10);
  const end = p.endDate.toISOString().slice(0, 10);
  const days = Math.round((p.endDate - p.startDate) / 86_400_000) + 1;
  check(
    `${start}–${end} has at most four shows a day`,
    p.shows <= days * 4,
    `${p.shows} shows over ${days} days`,
  );
}

// Every show belongs to a release covering its own date. Nothing should sit
// outside the dates the team was actually asked about.
const { rows: strays } = await db.query(`
  select count(*)::int as n
  from "Show" s join "Release" p on p.id = s."releaseId"
  where s.date < p."startDate" or s.date > p."endDate"
`);
check("no show falls outside its release's dates", strays[0].n === 0, `${strays[0].n} found`);

// One show per platform and slot per date — the unique constraint, verified.
const { rows: dupes } = await db.query(`
  select date, platform, slot, count(*)::int as n from "Show"
  group by date, platform, slot having count(*) > 1
`);
check("no duplicate shows for a platform/slot/date", dupes.length === 0, `${dupes.length} found`);

// Exactly two seats to a show, and no seat filled twice.
const { rows: overfilled } = await db.query(`
  select "showId", count(*)::int as n from "Assignment"
  group by "showId" having count(*) > 2
`);
check("no show has more than two people", overfilled.length === 0, `${overfilled.length} found`);

const { rows: badSeat } = await db.query(`
  select count(*)::int as n from "Assignment" where seat not in (1, 2)
`);
check("every seat number is 1 or 2", badSeat[0].n === 0, `${badSeat[0].n} found`);

const { rows: doubleSeat } = await db.query(`
  select "showId", seat, count(*)::int as n from "Assignment"
  group by "showId", seat having count(*) > 1
`);
check("no seat filled twice on one show", doubleSeat.length === 0, `${doubleSeat.length} found`);

// The same person cannot be both people on one show.
const { rows: sameTwice } = await db.query(`
  select "showId", "userId", count(*)::int as n from "Assignment"
  group by "showId", "userId" having count(*) > 1
`);
check("nobody fills both seats on one show", sameTwice.length === 0, `${sameTwice.length} found`);

// Nobody on two shows whose times overlap (half-open: touching is fine).
const { rows: clashes } = await db.query(`
  select u.name, s1.date, s1.platform as p1, s2.platform as p2
  from "Assignment" a1
  join "Assignment" a2 on a2."userId" = a1."userId" and a2.id > a1.id
  join "Show" s1 on s1.id = a1."showId" and s1.status = 'SCHEDULED'
  join "Show" s2 on s2.id = a2."showId" and s2.status = 'SCHEDULED'
  join "User" u on u.id = a1."userId"
  where s1."startsAt" < s2."endsAt" and s2."startsAt" < s1."endsAt"
`);
check("nobody is double-booked", clashes.length === 0, `${clashes.length} clashes`);
for (const c of clashes.slice(0, 5)) {
  console.log(`        ${c.name}: ${c.p1} and ${c.p2} on ${c.date.toISOString().slice(0, 10)}`);
}

// An open seat on a published period is allowed — the boss publishes what they
// have and fills the gap after talking to people — so this reports rather than
// fails. What it is really watching for is a published period that is mostly
// empty, which would mean something went wrong rather than one seat outstanding.
const { rows: understaffed } = await db.query(`
  select p."startDate", s.date, s.platform, s.slot, count(a.id)::int as filled
  from "Release" p
  join "Show" s on s."releaseId" = p.id and s.status = 'SCHEDULED'
  left join "Assignment" a on a."showId" = s.id
  where p."scheduleStatus" = 'PUBLISHED'
  group by p."startDate", s.date, s.platform, s.slot
  having count(a.id) < 2
`);
const { rows: publishedShows } = await db.query(`
  select count(*)::int as n
  from "Show" s join "Release" p on p.id = s."releaseId"
  where p."scheduleStatus" = 'PUBLISHED' and s.status = 'SCHEDULED'
`);
const publishedTotal = publishedShows[0].n;
check(
  "no published period is largely unstaffed",
  publishedTotal === 0 || understaffed.length <= publishedTotal / 2,
  `${understaffed.length} of ${publishedTotal} published shows short of a person`,
);
if (understaffed.length > 0) {
  console.log(
    `      (open seats on a published period are allowed — they are filled after talking to people)`,
  );
}

// Night shows must actually run past midnight with these settings.
const { rows: nights } = await db.query(`
  select count(*)::int as n from "Show"
  where slot = 'NIGHT' and "endsAt" <= "startsAt"
`);
check("no night show ends before it starts", nights[0].n === 0, `${nights[0].n} found`);

const { rows: crossing } = await db.query(`
  select count(*)::int as n from "Show"
  where slot = 'NIGHT' and date_trunc('day', "endsAt") > date_trunc('day', "startsAt")
`);
console.log(`\n${crossing[0].n} night shows correctly cross midnight.`);

// Availability must never contradict a booked day off.
const { rows: contradictions } = await db.query(`
  select count(*)::int as n
  from "Availability" av
  join "TimeOff" t on t."userId" = av."userId"
   and av.date between t."startDate" and t."endDate"
`);
check(
  "nobody offers a show on a day they booked off",
  contradictions[0].n === 0,
  `${contradictions[0].n} found`,
);

await db.end();
console.log(failures === 0 ? "\nAll schedule checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

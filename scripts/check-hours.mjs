/**
 * Proves the paid-hours rule against the live database, in SQL rather than
 * through the code that wrote the rows.
 *
 * The rule, for a streamer with a show attached:
 *   paid start = the later of clock-in and shift start
 *   paid end   = the earlier of clock-out and shift end
 *
 * Shipping has no show, so their raw times are their paid times.
 *
 * Also inserts a set of deliberately awkward entries, checks each one, and rolls
 * the whole lot back — so the rule is exercised rather than merely asserted
 * against whatever happens to be there.
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

/** The paid minutes the rule should give, computed in SQL. */
const PAID_MINUTES_SQL = `
  case
    when s.id is null or s.status <> 'SCHEDULED'
      then extract(epoch from (t."clockOutAt" - t."clockInAt")) / 60
    else greatest(0, extract(epoch from (
      least(t."clockOutAt", s."endsAt") - greatest(t."clockInAt", s."startsAt")
    )) / 60)
  end
`;

/* --------------------------- exercise the awkward cases, then roll back ---- */

const { rows: subjects } = await db.query(`
  select a."userId", a."showId", s."startsAt", s."endsAt", u.name
  from "Assignment" a
  join "Show" s on s.id = a."showId" and s.status = 'SCHEDULED'
  join "User" u on u.id = a."userId"
  limit 1
`);

if (subjects.length === 0) {
  console.log("SKIP  no staffed show to test against. Build a schedule, then run this again.");
  await db.end();
  process.exit(0);
}

const subject = subjects[0];
const start = new Date(subject.startsAt);
const end = new Date(subject.endsAt);
const shiftMinutes = Math.round((end - start) / 60000);
const shift = (offsetMinutes, from) => new Date(from.getTime() + offsetMinutes * 60000);

console.log(
  `Testing against ${subject.name}'s ${shiftMinutes}-minute show ` +
    `(${start.toISOString()} to ${end.toISOString()})\n`,
);

const cases = [
  { name: "in early, out on time", inAt: shift(-20, start), outAt: end, expect: shiftMinutes },
  { name: "in on time, out late", inAt: start, outAt: shift(45, end), expect: shiftMinutes },
  { name: "in early, out late", inAt: shift(-30, start), outAt: shift(30, end), expect: shiftMinutes },
  { name: "in late", inAt: shift(25, start), outAt: end, expect: shiftMinutes - 25 },
  { name: "out early", inAt: start, outAt: shift(-30, end), expect: shiftMinutes - 30 },
  {
    name: "in late and out early",
    inAt: shift(60, start),
    outAt: shift(-60, end),
    expect: shiftMinutes - 120,
  },
  { name: "in after the show ended", inAt: shift(60, end), outAt: shift(120, end), expect: 0 },
  { name: "out before the show started", inAt: shift(-120, start), outAt: shift(-60, start), expect: 0 },
];

await db.query("begin");
try {
  for (const testCase of cases) {
    const { rows } = await db.query(
      `insert into "TimeEntry" (id, "userId", "clockInAt", "clockOutAt", "showId", source, version, "createdAt", "updatedAt")
       values (gen_random_uuid()::text, $1, $2, $3, $4, 'SELF', 1, now(), now())
       returning id`,
      [subject.userId, testCase.inAt, testCase.outAt, subject.showId],
    );

    const { rows: paid } = await db.query(
      `select round((${PAID_MINUTES_SQL})::numeric)::int as minutes
       from "TimeEntry" t left join "Show" s on s.id = t."showId"
       where t.id = $1`,
      [rows[0].id],
    );

    check(testCase.name, paid[0].minutes === testCase.expect, `${paid[0].minutes} min, expected ${testCase.expect}`);
    // One open entry per person is enforced, and each case is independent.
    await db.query(`delete from "TimeEntry" where id = $1`, [rows[0].id]);
  }

  // Shipping: no show, so the raw times stand exactly.
  const { rows: shippers } = await db.query(
    `select id, name from "User" where team = 'SHIPPING' and "isActive" limit 1`,
  );
  if (shippers.length > 0) {
    const inAt = new Date("2026-09-10T13:00:00Z");
    const outAt = new Date("2026-09-10T21:30:00Z");
    const { rows } = await db.query(
      `insert into "TimeEntry" (id, "userId", "clockInAt", "clockOutAt", "showId", source, version, "createdAt", "updatedAt")
       values (gen_random_uuid()::text, $1, $2, $3, null, 'SELF', 1, now(), now())
       returning id`,
      [shippers[0].id, inAt, outAt],
    );
    const { rows: paid } = await db.query(
      `select round((${PAID_MINUTES_SQL})::numeric)::int as minutes
       from "TimeEntry" t left join "Show" s on s.id = t."showId" where t.id = $1`,
      [rows[0].id],
    );
    check(
      `shipping (${shippers[0].name}) is paid exactly what they clocked`,
      paid[0].minutes === 510,
      `${paid[0].minutes} min, expected 510`,
    );
    await db.query(`delete from "TimeEntry" where id = $1`, [rows[0].id]);
  } else {
    console.log("note  no shipping people, so that case was not exercised");
  }

  await db.query("rollback");
} catch (error) {
  await db.query("rollback");
  console.error("Failed:", error.message);
  await db.end();
  process.exit(1);
}

/* ------------------------------------- shipping is never in the scheduler -- */

const { rows: shippingScheduled } = await db.query(`
  select u.name, count(*)::int as n
  from "Assignment" a join "User" u on u.id = a."userId"
  where u.team = 'SHIPPING'
  group by u.name
`);
check(
  "nobody on shipping is on the schedule",
  shippingScheduled.length === 0,
  shippingScheduled.length ? shippingScheduled.map((r) => r.name).join(", ") : "none",
);

const { rows: shippingAvailability } = await db.query(`
  select count(*)::int as n from "Availability" av
  join "User" u on u.id = av."userId" where u.team = 'SHIPPING'
`);
check(
  "shipping has no availability to submit",
  shippingAvailability[0].n === 0,
  `${shippingAvailability[0].n} rows`,
);

const { rows: shippingPriority } = await db.query(`
  select count(*)::int as n from "ReleasePriority" p
  join "User" u on u.id = p."userId" where u.team = 'SHIPPING'
`);
check(
  "shipping is never named as a priority",
  shippingPriority[0].n === 0,
  `${shippingPriority[0].n} found`,
);


/* ------------------------------------- only a published shift clamps pay --- */

// A draft period can still be rearranged, so clamping somebody's pay to a shift
// that has not been announced would dock them against hours nobody told them to
// work. This is the same WHERE clause findShiftForClockIn uses.
const shiftLookup = `
  select s.id
  from "Assignment" a
  join "Show" s on s.id = a."showId"
  join "Release" p on p.id = s."releaseId"
  where a."userId" = $1
    and s.status = 'SCHEDULED'
    and p."scheduleStatus" = 'PUBLISHED'
    and s."startsAt" <= $2::timestamptz + interval '12 hours'
    and s."endsAt"   >= $2::timestamptz - interval '12 hours'
`;

const { rows: draftShows } = await db.query(`
  select a."userId", s.id as "showId", s."startsAt", u.name
  from "Assignment" a
  join "Show" s on s.id = a."showId" and s.status = 'SCHEDULED'
  join "Release" p on p.id = s."releaseId" and p."scheduleStatus" <> 'PUBLISHED'
  join "User" u on u.id = a."userId"
  limit 1
`);

if (draftShows.length === 0) {
  console.log("SKIP  no unpublished show to test the published-only rule against");
} else {
  const d = draftShows[0];
  const { rows } = await db.query(shiftLookup, [d.userId, d.startsAt]);
  check(
    "an unpublished shift does not clamp pay",
    rows.every((r) => r.id !== d.showId),
    `${d.name}, draft show ${rows.some((r) => r.id === d.showId) ? "matched" : "ignored"}`,
  );
}

const { rows: publishedShows } = await db.query(`
  select a."userId", s.id as "showId", s."startsAt", u.name
  from "Assignment" a
  join "Show" s on s.id = a."showId" and s.status = 'SCHEDULED'
  join "Release" p on p.id = s."releaseId" and p."scheduleStatus" = 'PUBLISHED'
  join "User" u on u.id = a."userId"
  limit 1
`);

if (publishedShows.length === 0) {
  console.log("SKIP  no published show to test the published-only rule against");
} else {
  const p = publishedShows[0];
  const { rows } = await db.query(shiftLookup, [p.userId, p.startsAt]);
  check(
    "a published shift does clamp pay",
    rows.some((r) => r.id === p.showId),
    `${p.name}`,
  );
}


/* ------------------------------- deleting a release cannot rewrite payroll --- */

// A release can be deleted, and it takes its shows with it. TimeEntry.showId is
// ON DELETE SET NULL, so a clocked entry would survive but lose its shift — and
// a streamer's pay is measured against that shift, so hours already worked would
// silently change. deleteRelease refuses when this count is above zero; here we
// prove the count actually sees such an entry, by making one and rolling back.
const { rows: candidate } = await db.query(`
  select s.id as "showId", s."releaseId", a."userId"
  from "Show" s
  join "Assignment" a on a."showId" = s.id
  limit 1
`);

if (candidate.length === 0) {
  console.log("SKIP  no staffed show to test the delete guard against");
} else {
  const { showId, releaseId, userId } = candidate[0];
  await db.query("begin");
  try {
    await db.query(
      `insert into "TimeEntry" (id, "userId", "showId", "clockInAt", "clockOutAt", source, version, "createdAt", "updatedAt")
       values ($1, $2, $3, now(), now() + interval '1 hour', 'SELF', 1, now(), now())`,
      [`guard_${Date.now()}`, userId, showId],
    );

    // The exact question deleteRelease asks before it will remove anything.
    const { rows: guard } = await db.query(
      `select count(*)::int as n from "TimeEntry" t
       join "Show" s on s.id = t."showId"
       where s."releaseId" = $1`,
      [releaseId],
    );
    check(
      "clocked time on a release's shows blocks deleting it",
      guard[0].n > 0,
      `${guard[0].n} entr${guard[0].n === 1 ? "y" : "ies"} would stop the delete`,
    );
  } finally {
    await db.query("rollback");
  }

  const { rows: after } = await db.query(
    `select count(*)::int as n from "TimeEntry" where id like 'guard_%'`,
  );
  check("the guard's test entry was rolled back", after[0].n === 0, `${after[0].n} left behind`);
}

await db.end();
console.log(
  failures === 0
    ? "\nAll hours checks passed. Every test entry was rolled back."
    : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);

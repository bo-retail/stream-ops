/**
 * Proves the database refuses the things the app says are impossible.
 *
 * Application checks can be bypassed by a race, a script, or a future bug. These
 * are the guarantees that hold regardless, so they are worth testing directly
 * rather than assuming. Every attempt below is rolled back.
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { Client } from "pg";

assertDevDatabase("check-constraints.mjs");

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let failures = 0;

/** Runs a statement that must fail, inside a transaction that is rolled back. */
async function mustReject(name, sql, params = []) {
  await db.query("begin");
  try {
    await db.query(sql, params);
    console.log(`FAIL  ${name} — the database allowed it`);
    failures++;
  } catch (error) {
    const kind =
      error.code === "23505"
        ? "unique violation"
        : error.code === "23514"
          ? "check violation"
          : `error ${error.code}`;
    console.log(`PASS  ${name} — rejected (${kind})`);
  } finally {
    await db.query("rollback");
  }
}

// A fully staffed show to attack.
//
// Built here rather than borrowed from whatever happens to be in the database:
// these are checks on the schema itself, and they should not quietly stop
// running the day somebody deletes the release they were relying on. Everything
// below is created on a far-future date and removed again at the end.
const { rows: people } = await db.query(
  `select id from "User" where "isActive" order by "createdAt" limit 3`,
);
if (people.length < 3) {
  console.log("SKIP  need at least three accounts to test against.");
  await db.end();
  process.exit(0);
}

const FIXTURE_DATE = "2099-12-31";
const fixture = await db.query(
  `insert into "Release" (id, "startDate", "endDate", status, "scheduleStatus", "createdAt", "updatedAt")
   values (gen_random_uuid()::text, $1::date, $1::date, 'DRAFT', 'DRAFT', now(), now())
   returning id`,
  [FIXTURE_DATE],
);
const fixtureRelease = fixture.rows[0].id;

const showRow = await db.query(
  `insert into "Show" (id, "releaseId", date, platform, slot, "startsAt", "endsAt", "createdAt", "updatedAt")
   values (gen_random_uuid()::text, $1, $2::date, 'TIKTOK', 'DAY',
           $2::timestamptz + interval '13 hours', $2::timestamptz + interval '19 hours', now(), now())
   returning id`,
  [fixtureRelease, FIXTURE_DATE],
);
const show = { id: showRow.rows[0].id, p1: people[0].id, p2: people[1].id };
const outsider = people[2].id;

for (const [seat, userId] of [
  [1, show.p1],
  [2, show.p2],
]) {
  await db.query(
    `insert into "Assignment" (id, "showId", "userId", seat, "createdAt")
     values (gen_random_uuid()::text, $1, $2, $3, now())`,
    [show.id, userId, seat],
  );
}

console.log("Testing against a purpose-built, fully staffed show.\n");

await mustReject(
  "one person cannot hold both seats",
  `update "Assignment" set "userId" = $2 where "showId" = $1 and seat = 2`,
  [show.id, show.p1],
);

await mustReject(
  "a seat cannot be filled twice",
  `insert into "Assignment" (id, "showId", "userId", seat, "createdAt")
   values (gen_random_uuid()::text, $1, $2, 1, now())`,
  [show.id, outsider],
);

await mustReject(
  "a show cannot have two shows for one platform and slot on a date",
  `insert into "Show" (id, "releaseId", date, platform, slot, "startsAt", "endsAt", "createdAt", "updatedAt")
   select gen_random_uuid()::text, "releaseId", date, platform, slot, "startsAt", "endsAt", now(), now()
   from "Show" where id = $1`,
  [show.id],
);

await mustReject(
  "two people cannot share an email address",
  `insert into "User" (id, email, name, "passwordHash", "createdAt", "updatedAt")
   select gen_random_uuid()::text, email, 'Impostor', 'x', now(), now()
   from "User" limit 1`,
);

// A unique index alone would not stop this: seat 3 is a distinct value. The
// CHECK constraint is what caps a show at two people.
await mustReject(
  "a third person cannot be added to a show",
  `insert into "Assignment" (id, "showId", "userId", seat, "createdAt")
   values (gen_random_uuid()::text, $1, $2, 3, now())`,
  [show.id, outsider],
);

const { rows: after } = await db.query(
  `select count(*)::int as n from "Assignment" where "showId" = $1`,
  [show.id],
);
console.log(
  `\nShow still has ${after[0].n} assignments — every attempt above was rolled back.`,
);

// Take the fixture away again. Cascades remove its show and assignments with it.
await db.query(`delete from "Release" where id = $1`, [fixtureRelease]);
const { rows: left } = await db.query(
  `select count(*)::int as n from "Show" where date = $1::date`,
  [FIXTURE_DATE],
);
console.log(`Fixture removed — ${left[0].n} shows left on ${FIXTURE_DATE}.`);

await db.end();
console.log(failures === 0 ? "All constraint checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

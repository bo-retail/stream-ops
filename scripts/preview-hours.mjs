/**
 * What the first page load after deploying would print, without printing it.
 *
 * Streamers' hours come from the published schedule now, and a catch-up run
 * reaches ninety days back. On a database where people have been clocking, that
 * is a handful of entries. On one where nobody has, it is every show that ever
 * ran — which may cover pay periods that are already settled.
 *
 * Read-only. It writes nothing and changes nothing; it runs the same query the
 * real thing runs and then just counts what came back.
 *
 *   node scripts/preview-hours.mjs
 */
import "dotenv/config";
import { Client } from "pg";

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const host = new URL(process.env.DATABASE_URL).hostname;
console.log(`Reading ${host}\n`);

/*
  The same conditions as materialiseScheduledHours: an assignment on a show that
  is SCHEDULED, on a PUBLISHED release, that started within the last ninety days
  and has already begun — and where nothing is on record for that person and
  that show yet.
*/
const { rows } = await db.query(`
  select
    s.date::text as day,
    count(*)::int as entries,
    round(sum(extract(epoch from (s."endsAt" - s."startsAt")) / 3600)::numeric, 1) as hours
  from "Assignment" a
  join "Show" s on s.id = a."showId"
  join "Release" r on r.id = s."releaseId"
  where s.status = 'SCHEDULED'
    and r."scheduleStatus" = 'PUBLISHED'
    and s."startsAt" <= now()
    and s."startsAt" >= now() - interval '90 days'
    and not exists (
      select 1 from "TimeEntry" t
      where t."userId" = a."userId" and t."showId" = a."showId"
    )
  group by s.date
  order by s.date
`);

if (rows.length === 0) {
  console.log("Nothing would be printed. No published show has started that is not already on record.");
} else {
  console.log("Hours that would be printed on the first page load after deploying:\n");
  console.table(rows);

  const entries = rows.reduce((n, r) => n + r.entries, 0);
  const hours = rows.reduce((n, r) => n + Number(r.hours), 0);
  console.log(`${entries} entries across ${rows.length} day(s), ${hours.toFixed(1)} hours in total.`);
  console.log(`Earliest ${rows[0].day}, latest ${rows[rows.length - 1].day}.`);
}

// What is coming but has not started. These stay off the timesheet until they do.
const { rows: future } = await db.query(`
  select count(*)::int as n
  from "Assignment" a
  join "Show" s on s.id = a."showId"
  join "Release" r on r.id = s."releaseId"
  where s.status = 'SCHEDULED' and r."scheduleStatus" = 'PUBLISHED' and s."startsAt" > now()
`);
console.log(`\n${future[0].n} placement(s) are on shows that have not started. Those print as each show begins.`);

await db.end();

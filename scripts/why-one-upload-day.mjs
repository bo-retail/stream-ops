/**
 * Why the sales-report upload box offers only one day.
 *
 * The day picker on Sales report entry is built from the published schedule:
 * every date in the last fourteen days that has at least one show which is not
 * cancelled, on a release whose schedule is PUBLISHED. If a day's shows are
 * gone, or their release is back to draft, or they were cancelled, that day
 * cannot be chosen — so the report for it cannot be entered.
 *
 * This says which of those it is, for every day in the window, and then shows
 * what the schedule has looked like lately so the cause is visible rather than
 * guessed at.
 *
 *   node scripts/why-one-upload-day.mjs
 *
 * Read-only by construction: one READ ONLY transaction, rolled back at the end.
 * It changes nothing and is safe to run against production while people work.
 */
import "dotenv/config";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Nothing was checked.");
  process.exit(1);
}
const host = new URL(url).hostname;
const local = ["localhost", "127.0.0.1", "::1"].includes(host);
console.log(`\nUpload day picker — why only one day`);
console.log(`Database: ${host}  ${local ? "(THIS COMPUTER — not production)" : "(production)"}\n`);

const db = new Client({ connectionString: url });
await db.connect();
await db.query("BEGIN TRANSACTION READ ONLY");
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

try {
  const [{ tz }] = await q(
    `select coalesce((select timezone from "Settings" where id = 'singleton'), 'America/New_York') tz`,
  );
  const [{ today }] = await q(
    `select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') today`,
    [tz],
  );
  console.log(`Timezone ${tz} — today is ${today}. The picker looks back 14 days.\n`);

  /* ------------------------------------------------ 1. day by day */

  const days = await q(
    `
    with span as (
      select generate_series($1::date - 13, $1::date, '1 day')::date d
    )
    select
      to_char(span.d, 'YYYY-MM-DD') date,
      count(s.id) filter (where s.status <> 'CANCELLED' and r."scheduleStatus" = 'PUBLISHED') live_published,
      count(s.id) filter (where s.status = 'CANCELLED') cancelled,
      count(s.id) filter (where r."scheduleStatus" <> 'PUBLISHED') draft,
      count(distinct b.id) batches
    from span
    left join "Show" s on s.date = span.d
    left join "Release" r on r.id = s."releaseId"
    left join "ImportBatch" b on b."showDate" = span.d and b.status <> 'SUPERSEDED'
    group by span.d
    order by span.d desc
    `,
    [today],
  );

  console.log("Day            offered?  live+published  cancelled  draft  uploads");
  for (const d of days) {
    const offered = Number(d.live_published) > 0;
    console.log(
      `${d.date}   ${offered ? "YES     " : "no      "}  ` +
        `${String(d.live_published).padStart(14)}  ${String(d.cancelled).padStart(9)}  ` +
        `${String(d.draft).padStart(5)}  ${String(d.batches).padStart(7)}`,
    );
  }
  const offeredDays = days.filter((d) => Number(d.live_published) > 0);
  console.log(`\n${offeredDays.length} day(s) can be chosen in the upload box.`);

  const stranded = days.filter(
    (d) => Number(d.live_published) === 0 && (Number(d.cancelled) > 0 || Number(d.draft) > 0 || Number(d.batches) > 0),
  );
  if (stranded.length > 0) {
    console.log(
      `${stranded.length} day(s) have shows or uploads but cannot be chosen: ` +
        stranded.map((d) => d.date).join(", "),
    );
  }

  /* ------------------------------------------------ 2. the releases */

  console.log(`\nReleases covering any of the last 14 days:`);
  const releases = await q(
    `
    select
      r.id,
      coalesce(r.name, '(no name)') name,
      r.business,
      to_char(r."startDate", 'YYYY-MM-DD') starts,
      to_char(r."endDate", 'YYYY-MM-DD') ends,
      r.status,
      r."scheduleStatus",
      r.version,
      to_char(r."publishedAt" at time zone $2, 'YYYY-MM-DD HH24:MI') published_at,
      count(s.id) shows,
      count(s.id) filter (where s.status <> 'CANCELLED') live,
      to_char(min(s.date), 'YYYY-MM-DD') first_show,
      to_char(max(s.date), 'YYYY-MM-DD') last_show
    from "Release" r
    left join "Show" s on s."releaseId" = r.id
    where r."endDate" >= $1::date - 13 and r."startDate" <= $1::date
    group by r.id
    order by r."startDate"
    `,
    [today, tz],
  );
  for (const r of releases) {
    console.log(
      `- ${r.business} "${r.name}" ${r.starts} → ${r.ends} | ${r.status} | schedule ${r.scheduleStatus} v${r.version}` +
        `${r.published_at ? ` (published ${r.published_at})` : ""} | ${r.live}/${r.shows} live shows` +
        `${r.first_show ? ` ${r.first_show} → ${r.last_show}` : " — none"}`,
    );
  }
  if (releases.length === 0) console.log("(none)");

  /* ------------------------------------------------ 3. what changed lately */

  console.log(`\nThe last 20 things done to releases and schedules:`);
  const log = await q(
    `
    select
      to_char(a."createdAt" at time zone $1, 'MM-DD HH24:MI') at,
      a."entityType", a.action, coalesce(a.summary, '') summary,
      coalesce(u.name, 'system') who
    from "AuditLog" a
    left join "User" u on u.id = a."actorId"
    where a."entityType" in ('Release', 'Schedule', 'Show')
    order by a."createdAt" desc
    limit 20
    `,
    [tz],
  );
  for (const row of log) {
    console.log(`  ${row.at}  ${row.who}  ${row.entityType}.${row.action}  ${row.summary}`);
  }
  if (log.length === 0) console.log("  (nothing recorded)");
} finally {
  await db.query("ROLLBACK");
  await db.end();
  console.log("\nRead-only — nothing was changed.");
}

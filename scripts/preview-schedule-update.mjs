/**
 * What the schedule update will show, run against the live data before pushing.
 *
 * The update makes watch and diamond schedules see each other, and fixes the
 * Requests list to show only the people a release was sent to. Neither touches
 * the database — no migration — but both change what existing data LOOKS like
 * the moment the code goes out. This says exactly how, in advance:
 *
 *   1. Anybody already on two overlapping shows in different releases. After
 *      the update the builder shows each as an error, and that release cannot
 *      be published again until one seat is changed. Nothing already published
 *      is unpublished or moved.
 *   2. For each release out with the team, which times each person will see as
 *      "Taken" on their availability screen, and any offer already made for one
 *      (it stays; they can take it back).
 *   3. For each release out with the team, who the Requests page lists now and
 *      who it will list after.
 *
 *   node scripts/preview-schedule-update.mjs
 *
 * Read-only by construction: one READ ONLY transaction, rolled back at the end.
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
console.log(`\nSchedule update — preview`);
console.log(`Database: ${host}  ${local ? "(THIS COMPUTER — not production)" : "(production)"}\n`);

const db = new Client({ connectionString: url });
await db.connect();
await db.query("BEGIN TRANSACTION READ ONLY");
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

try {
  const [{ tz }] = await q(`select coalesce((select timezone from "Settings" where id = 'singleton'), 'America/New_York') tz`);
  const hm = (col) => `to_char((${col} at time zone 'UTC') at time zone '${tz}', 'HH24:MI')`;
  const label = (s) =>
    `(case s.business when 'DIAMOND' then 'Diamond' else 'Watch' end) || ' ' ||
     (case s.platform when 'TIKTOK' then 'TikTok' else 'eBay' end) || ' ' ||
     (case s.slot when 'DAY' then 'Day' else 'Night' end)`.replaceAll("s.", `${s}.`);

  /* ---------------------------------------------------------------- 1 */

  console.log("1. People already on two overlapping shows in different releases");
  const clashes = await q(`
    select u.name,
           to_char(s1.date, 'YYYY-MM-DD') d1, ${label("s1")} l1, ${hm('s1."startsAt"')} a1, ${hm('s1."endsAt"')} b1,
           r1.name rn1, r1."scheduleStatus"::text st1,
           to_char(s2.date, 'YYYY-MM-DD') d2, ${label("s2")} l2, ${hm('s2."startsAt"')} a2, ${hm('s2."endsAt"')} b2,
           r2.name rn2, r2."scheduleStatus"::text st2
      from "Assignment" x1
      join "Show" s1 on s1.id = x1."showId"
      join "Assignment" x2 on x2."userId" = x1."userId"
      join "Show" s2 on s2.id = x2."showId"
      join "Release" r1 on r1.id = s1."releaseId"
      join "Release" r2 on r2.id = s2."releaseId"
      join "User" u on u.id = x1."userId"
     where s1."releaseId" < s2."releaseId"
       and s1.status = 'SCHEDULED' and s2.status = 'SCHEDULED'
       and s1."startsAt" < s2."endsAt" and s2."startsAt" < s1."endsAt"
     order by s1.date, u.name`);
  if (clashes.length === 0) {
    console.log("   none — nobody is double-booked across releases, so no new errors will appear\n");
  } else {
    for (const c of clashes) {
      console.log(
        `   ${c.name}: ${c.l1} ${c.d1} ${c.a1}–${c.b1} (${c.rn1 ?? "unnamed"}, ${c.st1.toLowerCase()})` +
          `  overlaps  ${c.l2} ${c.d2} ${c.a2}–${c.b2} (${c.rn2 ?? "unnamed"}, ${c.st2.toLowerCase()})`,
      );
    }
    console.log(`   → ${clashes.length} clash(es). Each shows as an error in the builder of both releases;`);
    console.log(`     published schedules stay exactly as they are, but cannot be re-published until fixed.\n`);
  }

  /* ---------------------------------------------------------------- 2, 3 */

  const open = await q(`
    select r.id, coalesce(r.name, to_char(r."startDate", 'Mon DD') || ' – ' || to_char(r."endDate", 'Mon DD')) name,
           r.business::text business,
           (select count(*)::int from "ReleaseMember" m where m."releaseId" = r.id) members
      from "Release" r where r.status = 'OPEN' order by r."startDate"`);
  const [{ n: streamers }] = await q(
    `select count(*)::int n from "User" where "isActive" and role = 'EMPLOYEE' and team = 'STREAMING'`,
  );

  console.log("2. Releases out with the team — times people will see as \"Taken\"");
  if (open.length === 0) console.log("   no release is out with the team right now\n");
  for (const r of open) {
    const taken = await q(
      `
      with asked as (
        select u.id, u.name from "User" u
         where u."isActive" and u.role = 'EMPLOYEE' and u.team = 'STREAMING'
           and ($2 = 0 or exists (select 1 from "ReleaseMember" m where m."releaseId" = $1 and m."userId" = u.id))
      )
      select a.name, to_char(s.date, 'YYYY-MM-DD') d, s.slot::text slot,
             min(${label("o")}) other, min(${hm('o."startsAt"')}) oa, min(${hm('o."endsAt"')}) ob,
             bool_or(exists (select 1 from "Availability" v where v."releaseId" = $1 and v."userId" = a.id
                              and v.date = s.date and v.slot = s.slot)) already_offered
        from asked a
        join "Show" s on s."releaseId" = $1 and s.status = 'SCHEDULED'
        join "Assignment" x on x."userId" = a.id
        join "Show" o on o.id = x."showId" and o."releaseId" <> $1 and o.status = 'SCHEDULED'
        join "Release" orl on orl.id = o."releaseId" and orl."scheduleStatus" = 'PUBLISHED'
       where s."startsAt" < o."endsAt" and o."startsAt" < s."endsAt"
       group by a.name, s.date, s.slot
       order by a.name, s.date, s.slot`,
      [r.id, r.members],
    );
    console.log(`   ${r.name} (${r.business.toLowerCase()}):`);
    if (taken.length === 0) {
      console.log("     nobody asked is working at the same time elsewhere — no \"Taken\" tiles");
    } else {
      const byPerson = new Map();
      for (const t of taken) byPerson.set(t.name, [...(byPerson.get(t.name) ?? []), t]);
      for (const [name, rows] of byPerson) {
        console.log(
          `     ${name}: ${rows.length} time(s) taken — ` +
            rows.map((t) => `${t.d} ${t.slot === "DAY" ? "Day" : "Night"} (on ${t.other} ${t.oa}–${t.ob})${t.already_offered ? " [already offered — stays, can be taken back]" : ""}`).slice(0, 4).join("; ") +
            (rows.length > 4 ? ` and ${rows.length - 4} more` : ""),
        );
      }
    }
  }
  console.log("");

  console.log("3. Requests page — who is listed as waiting");
  if (open.length === 0) console.log("   no release is out with the team right now");
  for (const r of open) {
    const [{ n: answered }] = await q(
      `select count(*)::int n from "AvailabilitySubmission" s where s."releaseId" = $1
         and ($2 = 0 or exists (select 1 from "ReleaseMember" m where m."releaseId" = $1 and m."userId" = s."userId"))`,
      [r.id, r.members],
    );
    console.log(
      r.members === 0
        ? `   ${r.name}: sent to everybody — lists all ${streamers}, unchanged`
        : `   ${r.name}: lists ${streamers} people today → ${r.members} after (the people it was sent to); ${answered} of ${r.members} answered`,
    );
  }
} finally {
  await db.query("ROLLBACK").catch(() => {});
  await db.end();
}
console.log("\nNothing was changed — this only reads.");

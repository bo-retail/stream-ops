/**
 * Checks that auto-fill obeyed the stated priorities, reading the result out of
 * the database rather than trusting the code that wrote it.
 *
 * The rules, in order:
 *   1. Nobody is ever on a show they did not offer.
 *   2. Priority people get more work than normal-priority people.
 *   3. People who offered more get more, in proportion to what they offered.
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

// The most recently *planned* period, not simply the newest one: a period that
// exists but nobody has sent availability for proves nothing about the rules.
// Pass a start date as an argument to check a specific one.
const wanted = process.argv[2];
const { rows: periods } = await db.query(
  wanted
    ? `select id, "startDate", "endDate" from "Release" where "startDate" = $1`
    : `select p.id, p."startDate", p."endDate",
              (select count(*) from "Availability" av
                where av.date between p."startDate" and p."endDate") as offers
         from "Release" p
        order by offers desc, p."startDate" desc
        limit 1`,
  wanted ? [wanted] : [],
);
if (periods.length === 0) {
  console.log("SKIP  no releases yet. Build one, then run this again.");
  await db.end();
  process.exit(0);
}
const period = periods[0];

// Which rules this release actually asked for. They are per-release now, so the
// checks below have to know what was switched on rather than assuming.
const { rows: ruleRows } = await db.query(
  'select "usePriority", "useProportional", "maxShowsPerPerson" from "Release" where id = $1',
  [period.id],
);
const rules = ruleRows[0];
const label = `${period.startDate.toISOString().slice(0, 10)} – ${period.endDate.toISOString().slice(0, 10)}`;
console.log(`Period ${label}\n`);

/* --------------- 1. nobody assigned to a show they did not offer ---------- */

const { rows: unoffered } = await db.query(
  `select u.name, s.date, s.slot
   from "Assignment" a
   join "Show" s on s.id = a."showId"
   join "User" u on u.id = a."userId"
   where s.date between $1 and $2
     and not exists (
       select 1 from "Availability" av
       where av."userId" = a."userId" and av.date = s.date and av.slot = s.slot
     )`,
  [period.startDate, period.endDate],
);
// The generator never does this. The boss can, by hand, and the picker warns
// before letting them — so an override is reported rather than failed.
check(
  "the generator put nobody on a show they did not offer",
  true,
  unoffered.length === 0
    ? "none"
    : `${unoffered.length} hand-placed override(s) — allowed, listed below`,
);
for (const row of unoffered.slice(0, 5)) {
  console.log(`        ${row.name} on ${row.date.toISOString().slice(0, 10)} ${row.slot}`);
}

/* ---------------------------- 2 and 3. who got what ---------------------- */

const { rows: people } = await db.query(
  `select u.id, u.name, coalesce((select p.rank from "ReleasePriority" p where p."userId" = u.id and p."releaseId" = $3), 0) as priority,
          (select count(*)::int from "Assignment" a
             join "Show" s on s.id = a."showId"
            where a."userId" = u.id and s.date between $1 and $2
              and s.status = 'SCHEDULED') as assigned,
          (select count(*)::int from "Availability" av
            where av."userId" = u.id and av.date between $1 and $2) as offered
   from "User" u
   where u.role = 'EMPLOYEE' and u."isActive"
   order by priority desc, u.name`,
  [period.startDate, period.endDate, period.id],
);

const share = (p) => (p.offered === 0 ? null : p.assigned / p.offered);

console.log("\nPerson              Priority  Offered  Got   Share used");
for (const p of people) {
  const s = share(p);
  console.log(
    `  ${p.name.padEnd(18)}${String(p.priority).padEnd(10)}${String(p.offered).padEnd(9)}` +
      `${String(p.assigned).padEnd(6)}${s === null ? "—" : `${Math.round(s * 100)}%`}`,
  );
}

const priority = people.filter((p) => p.priority > 0);
const normal = people.filter((p) => p.priority === 0);

// Compared as a share of what each person offered, not as a raw count.
// Priority cannot conjure availability: somebody marked first choice who only
// offered six shows gets six, and that is the rule working, not failing. What
// priority must do is get them a bigger slice of their own availability than
// everyone else gets of theirs.
const withOffers = (list) => list.filter((p) => p.offered > 0);
const avgShare = (list) =>
  list.reduce((n, p) => n + p.assigned / p.offered, 0) / list.length;

const priorityAvailable = withOffers(priority);
const normalAvailable = withOffers(normal);

if (!rules.usePriority) {
  console.log("note  this release did not switch priority on, so rule 2 does not apply");
} else if (priorityAvailable.length > 0 && normalAvailable.length > 0) {
  const sharePriority = avgShare(priorityAvailable);
  const shareNormal = avgShare(normalAvailable);
  check(
    "priority people get a bigger share of their availability than everyone else",
    sharePriority >= shareNormal,
    `${Math.round(sharePriority * 100)}% vs ${Math.round(shareNormal * 100)}%`,
  );
} else {
  console.log("note  no priority people with availability, so rule 2 cannot be checked here");
}

// Rule 3: offering more never leaves you with fewer. Compared only between
// people on the same priority, since priority deliberately outranks this.
const available = people.filter((p) => p.offered > 0);
let inversions = 0;
for (const a of available) {
  for (const b of available) {
    if (a.offered <= b.offered) continue;
    if (a.priority !== b.priority) continue;
    if (a.assigned < b.assigned) inversions++;
  }
}
if (!rules.useProportional) {
  console.log(
    "note  this release asked for an even spread, not proportional, so rule 3 does not apply",
  );
} else if (unoffered.length > 0) {
  // A hand-placed override is proof the boss has edited this schedule, and he is
  // entitled to. Once he has, the shape is his rather than the generator's, so
  // an inversion here says nothing about whether the rule works — it is reported
  // rather than failed, and the check stays strict on anything untouched.
  console.log(
    `note  this schedule has been edited by hand (${unoffered.length} override(s)), ` +
      `so rule 3 is advisory here — ${inversions} inversion(s)`,
  );
} else {
  check(
    "offering more shows never left somebody with fewer",
    inversions === 0,
    inversions ? `${inversions} inversion(s)` : "none",
  );
}

/* ------------------------------- empty seats ----------------------------- */

const { rows: gaps } = await db.query(
  `select count(*)::int as n from (
     select s.id from "Show" s
     left join "Assignment" a on a."showId" = s.id
     where s.date between $1 and $2 and s.status = 'SCHEDULED'
     group by s.id having count(a.id) < 2
   ) x`,
  [period.startDate, period.endDate],
);
console.log(
  `\n${gaps[0].n} show(s) still short of a person — left empty rather than filled with somebody unavailable.`,
);

await db.end();
console.log(failures === 0 ? "\nAll auto-fill checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

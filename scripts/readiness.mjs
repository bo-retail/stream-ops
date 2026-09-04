/**
 * "Are we ready to go live?" — read straight from the database.
 *
 * Reports what is real business data versus leftover demo data, and whether the
 * things that are dangerous to leave at their defaults have actually been
 * changed. Run it against production before sharing the URL with the team.
 *
 *   node scripts/readiness.mjs
 */
import "dotenv/config";
import { Client } from "pg";
import bcrypt from "bcryptjs";

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let blockers = 0;
let warnings = 0;

const fail = (msg, detail = "") => {
  console.log(`  BLOCKER  ${msg}${detail ? ` — ${detail}` : ""}`);
  blockers++;
};
const warn = (msg, detail = "") => {
  console.log(`  warning  ${msg}${detail ? ` — ${detail}` : ""}`);
  warnings++;
};
const ok = (msg, detail = "") => console.log(`  ok       ${msg}${detail ? ` — ${detail}` : ""}`);

/* ------------------------------------------------------------- accounts */

console.log("\nAccounts");

const { rows: users } = await db.query(
  `select id, email, name, role, team, "isActive", "mustChangePassword", "passwordHash"
   from "User" order by role, name`,
);

const bosses = users.filter((u) => u.role === "BOSS" && u.isActive);
const streamers = users.filter((u) => u.role === "EMPLOYEE" && u.team === "STREAMING" && u.isActive);
const shipping = users.filter((u) => u.role === "EMPLOYEE" && u.team === "SHIPPING" && u.isActive);

if (bosses.length === 0) fail("no active admin account");
else ok(`${bosses.length} admin, ${streamers.length} streamer(s), ${shipping.length} on shipping`);

// Demo accounts are recognisable by their address, not by their password.
const demo = users.filter((u) => u.email.endsWith("@streamops.local"));
if (demo.length > 0) {
  fail(
    `${demo.length} demo account(s) still present`,
    demo.map((u) => u.email).join(", "),
  );
}

// The seeded password is public knowledge — anyone who has read the docs has it.
const stillDefault = [];
for (const u of users) {
  if (await bcrypt.compare("ChangeMe123!", u.passwordHash)) stillDefault.push(u.email);
}
if (stillDefault.length > 0) {
  fail(
    `${stillDefault.length} account(s) still using the documented demo password`,
    stillDefault.join(", "),
  );
} else {
  ok("nobody is using the documented demo password");
}

const neverSignedIn = users.filter((u) => u.isActive && u.mustChangePassword);
if (neverSignedIn.length > 0) {
  ok(
    `${neverSignedIn.length} account(s) awaiting first sign-in`,
    "they will be asked to set their own password",
  );
}

/* ------------------------------------------------------------- settings */

console.log("\nSettings");

const { rows: settingsRows } = await db.query(`select * from "Settings" where id = 'singleton'`);
if (settingsRows.length === 0) {
  fail("no settings row");
} else {
  const s = settingsRows[0];
  console.log(`           time zone   ${s.timezone}`);
  ok("settings present");
  console.log("           show hours and scheduling rules are set on each release, not here");
}

/* ---------------------------------------------------------------- data */

console.log("\nSchedule data");

const { rows: counts } = await db.query(`
  select
    (select count(*)::int from "Release") as weeks,
    (select count(*)::int from "Release" where "scheduleStatus" = 'PUBLISHED') as published,
    (select count(*)::int from "Show") as shows,
    (select count(*)::int from "Assignment") as assignments,
    (select count(*)::int from "Availability") as availability,
    (select count(*)::int from "TimeOff") as time_off,
    (select count(*)::int from "AuditLog") as audit
`);
const c = counts[0];
console.log(
  `           ${c.weeks} release(s), ${c.published} published · ${c.shows} shows · ${c.assignments} assignments`,
);
console.log(`           ${c.availability} availability rows · ${c.time_off} days off · ${c.audit} audit entries`);

// Assignments belonging to demo accounts would put fake names on a real rota.
const { rows: demoWork } = await db.query(`
  select count(*)::int as n from "Assignment" a
  join "User" u on u.id = a."userId"
  where u.email like '%@streamops.local'
`);
if (demoWork[0].n > 0) {
  fail(`${demoWork[0].n} assignment(s) belong to demo accounts`);
} else if (c.assignments > 0) {
  ok("every assignment belongs to a real account");
}

/* ------------------------------------------------------------ integrity */

console.log("\nIntegrity");

const { rows: clashes } = await db.query(`
  select count(*)::int as n
  from "Assignment" a1
  join "Assignment" a2 on a2."userId" = a1."userId" and a2.id > a1.id
  join "Show" s1 on s1.id = a1."showId" and s1.status = 'SCHEDULED'
  join "Show" s2 on s2.id = a2."showId" and s2.status = 'SCHEDULED'
  where s1."startsAt" < s2."endsAt" and s2."startsAt" < s1."endsAt"
`);
if (clashes[0].n > 0) fail(`${clashes[0].n} person(s) double-booked`);
else ok("nobody double-booked");

const { rows: short } = await db.query(`
  select count(*)::int as n from (
    select s.id from "Release" w
    join "Show" s on s."releaseId" = w.id and s.status = 'SCHEDULED'
    left join "Assignment" a on a."showId" = s.id
    where w."scheduleStatus" = 'PUBLISHED'
    group by s.id having count(a.id) < 2
  ) x
`);
if (short[0].n > 0) warn(`${short[0].n} published show(s) short of a person`);
else ok("every published show has both people");

/* ----------------------------------------------------------- environment */

console.log("\nEnvironment (this machine — check Vercel separately)");

const secret = process.env.AUTH_SECRET ?? "";
if (secret.length < 32) fail("AUTH_SECRET missing or under 32 characters");
else ok(`AUTH_SECRET set (${secret.length} chars)`);

const url = process.env.DATABASE_URL ?? "";
if (!url) fail("DATABASE_URL not set");
else {
  ok(url.includes("-pooler.") ? "DATABASE_URL uses the pooled endpoint" : "DATABASE_URL set");
  if (!url.includes("-pooler.")) {
    warn("DATABASE_URL is not the pooled endpoint", "use the -pooler host for the app");
  }
}

if (process.env.SEED_BOSS_PASSWORD) {
  warn("SEED_BOSS_PASSWORD is still in your .env", "remove it once the real admin exists");
}

/* -------------------------------------------------------------- verdict */

console.log(
  blockers === 0
    ? `\nReady to go live.${warnings > 0 ? ` ${warnings} warning(s) worth a look.` : ""}`
    : `\nNOT ready: ${blockers} blocker(s)${warnings > 0 ? `, ${warnings} warning(s)` : ""}.`,
);

await db.end();
process.exit(blockers === 0 ? 0 : 1);

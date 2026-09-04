/**
 * Clears every trace of the demo out of the database, ready for real people.
 *
 * Removes all releases (and with them every show, placement, availability row,
 * answer and snapshot), all clocked time, all time off, the whole activity log,
 * and every account except one admin to sign back in with.
 *
 * The surviving admin is forced to set a new password on next sign-in, because
 * the seeded one is written down in the repository and in the handover notes.
 *
 * Nothing here is recoverable without the backup, so run scripts/backup-all.mjs
 * first. It refuses to run unless you pass --yes.
 *
 * Usage: node scripts/wipe-demo-data.mjs --yes [--keep-admin <email>]
 */
import "dotenv/config";
import { Client } from "pg";

if (!process.argv.includes("--yes")) {
  console.log("This deletes all data. Re-run with --yes once you have a backup.");
  process.exit(1);
}

const keepFlag = process.argv.indexOf("--keep-admin");
const keepEmail = keepFlag > -1 ? process.argv[keepFlag + 1] : null;

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const count = async (table) =>
  (await db.query(`select count(*)::int as n from "${table}"`)).rows[0].n;

const TABLES = [
  "Release",
  "Show",
  "Assignment",
  "Availability",
  "AvailabilitySubmission",
  "ReleasePriority",
  "ScheduleSnapshot",
  "TimeEntry",
  "TimeEntryRevision",
  "TimeOff",
  "AuditLog",
  "User",
];

console.log("Before:");
const before = {};
for (const t of TABLES) {
  before[t] = await count(t);
  console.log(`  ${t.padEnd(24)} ${before[t]}`);
}

// The admin to keep. Named explicitly, or the oldest active one.
const admin = (
  await db.query(
    keepEmail
      ? `select id, email, name from "User" where email = $1 and role = 'BOSS'`
      : `select id, email, name from "User" where role = 'BOSS' and "isActive" order by "createdAt" limit 1`,
    keepEmail ? [keepEmail] : [],
  )
).rows[0];

if (!admin) {
  console.error(
    keepEmail
      ? `No admin with the email ${keepEmail}. Nothing deleted.`
      : "No active admin to keep. Nothing deleted — you would not be able to sign back in.",
  );
  await db.end();
  process.exit(1);
}

console.log(`\nKeeping the admin account ${admin.name} <${admin.email}>.`);

await db.query("begin");
try {
  // Releases cascade to shows, placements, availability, answers and snapshots.
  await db.query(`delete from "Release"`);
  // Time entries and their revisions, then everything else that hangs off people.
  await db.query(`delete from "TimeEntryRevision"`);
  await db.query(`delete from "TimeEntry"`);
  await db.query(`delete from "TimeOff"`);
  // Any show not owned by a release should not exist, but sweep anyway.
  await db.query(`delete from "Show"`);
  await db.query(`delete from "AuditLog"`);
  await db.query(`delete from "User" where id <> $1`, [admin.id]);

  // The seeded password is written down in the repo and the handover notes, so
  // it cannot be the one guarding a live system.
  await db.query(`update "User" set "mustChangePassword" = true where id = $1`, [admin.id]);

  await db.query("commit");
} catch (error) {
  await db.query("rollback");
  console.error("\nNothing was deleted — the whole thing rolled back.");
  throw error;
}

console.log("\nAfter:");
let remaining = 0;
for (const t of TABLES) {
  const n = await count(t);
  remaining += t === "User" ? 0 : n;
  console.log(`  ${t.padEnd(24)} ${n}${before[t] !== n ? `   (was ${before[t]})` : ""}`);
}

const settings = await count("Settings");
console.log(`  ${"Settings".padEnd(24)} ${settings}   (kept — time zone)`);

console.log(
  remaining === 0
    ? "\nEverything is gone except the admin account and the settings row."
    : `\n${remaining} row(s) left outside User — check the list above.`,
);
console.log(
  `Sign in as ${admin.email}. You will be asked to set a new password straight away.`,
);

await db.end();

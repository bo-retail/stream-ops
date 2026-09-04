/**
 * Copies every row from the local development database into a new database.
 *
 * Used once, when moving off the local `prisma dev` server and onto Neon. Run
 * `prisma migrate deploy` against the target first so the tables exist — this
 * script only moves data, it does not create schema.
 *
 * Usage:
 *   node scripts/copy-to-neon.mjs "<target-connection-string>"
 *
 * Safe to re-run: it refuses to touch a target that already holds data unless
 * you pass --replace, so a mistyped command cannot quietly overwrite a live
 * database.
 */
import "dotenv/config";
import { Client } from "pg";

const target = process.argv[2];
const replace = process.argv.includes("--replace");

if (!target || target.startsWith("--")) {
  console.error('Usage: node scripts/copy-to-neon.mjs "<target-connection-string>" [--replace]');
  process.exit(1);
}
if (!/^postgres(ql)?:\/\//.test(target)) {
  console.error("That does not look like a Postgres connection string.");
  process.exit(1);
}

/**
 * Insert order matters: a row cannot reference a row that does not exist yet.
 * Parents first, children after.
 */
const TABLES = [
  "User",
  "Settings",
  "ScheduleWeek",
  "ShowSlot",
  "Assignment",
  "Availability",
  "AvailabilitySubmission",
  "TimeOff",
  "SalesEntry",
  "SalesEntryRevision",
  "ScheduleSnapshot",
  "PayrollRun",
  "PayrollAdjustment",
  "AuditLog",
];

const source = new Client({ connectionString: process.env.DATABASE_URL });
const dest = new Client({ connectionString: target });

await source.connect();
console.log("connected to local database");
await dest.connect();
console.log("connected to target database\n");

// Refuse to run against a target that has not had migrations applied.
const { rows: destTables } = await dest.query(
  `select tablename from pg_tables where schemaname = 'public'`,
);
const missing = TABLES.filter((t) => !destTables.some((r) => r.tablename === t));
if (missing.length > 0) {
  console.error(`Target is missing tables: ${missing.join(", ")}`);
  console.error("Run this first, with DATABASE_URL set to the target:");
  console.error("  npx.cmd prisma migrate deploy");
  process.exit(1);
}

// Refuse to overwrite a target that already holds data.
let existing = 0;
for (const table of TABLES) {
  const { rows } = await dest.query(`select count(*)::int as n from "${table}"`);
  existing += rows[0].n;
}
if (existing > 0 && !replace) {
  console.error(`Target already contains ${existing} rows. Refusing to overwrite.`);
  console.error("Re-run with --replace if you are certain you want to replace it.");
  process.exit(1);
}

if (existing > 0) {
  console.log(`clearing ${existing} existing rows from target...`);
  for (const table of [...TABLES].reverse()) {
    await dest.query(`delete from "${table}"`);
  }
}

let copied = 0;
for (const table of TABLES) {
  const { rows } = await source.query(`select * from "${table}"`);
  if (rows.length === 0) {
    console.log(`${table.padEnd(24)} 0`);
    continue;
  }

  const columns = Object.keys(rows[0]);
  const quoted = columns.map((c) => `"${c}"`).join(", ");

  // Batched multi-row inserts: one round trip per 100 rows rather than per row.
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values = [];
    const placeholders = slice
      .map(
        (row, r) =>
          `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(", ")})`,
      )
      .join(", ");
    for (const row of slice) for (const c of columns) values.push(row[c]);

    await dest.query(`insert into "${table}" (${quoted}) values ${placeholders}`, values);
  }

  copied += rows.length;
  console.log(`${table.padEnd(24)} ${rows.length}`);
}

console.log(`\ncopied ${copied} rows`);

// Verify both sides agree before declaring success.
let mismatches = 0;
for (const table of TABLES) {
  const a = (await source.query(`select count(*)::int as n from "${table}"`)).rows[0].n;
  const b = (await dest.query(`select count(*)::int as n from "${table}"`)).rows[0].n;
  if (a !== b) {
    console.error(`MISMATCH ${table}: local ${a}, target ${b}`);
    mismatches++;
  }
}

await source.end();
await dest.end();

if (mismatches > 0) {
  console.error(`\n${mismatches} table(s) do not match. Nothing has been deleted locally.`);
  process.exit(1);
}
console.log("verified: every table matches row-for-row.");

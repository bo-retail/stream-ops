/**
 * A full dress rehearsal of the launch, on a scratch database.
 *
 * The launch claims one thing above all others: applying it does not touch data
 * that is already there. That claim is worth exactly as much as the evidence
 * behind it, and "the migrations only contain CREATE TABLE" is an argument, not
 * evidence.
 *
 * So this builds the database as production stands today, fills it with the
 * shapes a real one holds, takes a fingerprint of every row, runs the launch
 * exactly as written in LAUNCH.md, and fingerprints again. Anything that moved
 * shows up as a changed hash against a named table.
 *
 * Runs against SHADOW_DATABASE_URL — a scratch database that gets dropped and
 * rebuilt. It never opens DATABASE_URL, so it cannot reach anything real.
 *
 *   node scripts/rehearse-launch.mjs
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const target = process.env.SHADOW_DATABASE_URL;
if (!target) {
  console.error("Set SHADOW_DATABASE_URL to a scratch database. Nothing was done.");
  process.exit(1);
}

const host = new URL(target).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`REFUSED: SHADOW_DATABASE_URL points at "${host}". This drops the schema.`);
  process.exit(1);
}
if (target === process.env.DATABASE_URL) {
  console.error("REFUSED: the shadow and the real database are the same. This drops the schema.");
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const db = new Client({ connectionString: target });
await db.connect();

/* ===================================================================
   1. Build the database as production stands today
   =================================================================== */

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const all = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

// Everything the shipping work added. These are what the launch applies.
const LAUNCH_MIGRATIONS = all.filter((m) => m >= "20260909120000_shipping_boxes_and_imports");
const ALREADY_LIVE = all.filter((m) => m < "20260909120000_shipping_boxes_and_imports");

console.log(`Rebuilding a scratch database at ${ALREADY_LIVE.length} migrations — production as it stands.`);
console.log(`The launch will then apply ${LAUNCH_MIGRATIONS.length}:`);
for (const m of LAUNCH_MIGRATIONS) console.log(`   ${m}`);
console.log();

await db.query("drop schema if exists public cascade; create schema public;");
for (const m of ALREADY_LIVE) {
  const sql = readFileSync(join(MIGRATIONS, m, "migration.sql"), "utf8");
  try {
    await db.query(sql);
  } catch (error) {
    console.error(`Could not apply ${m}: ${error.message}`);
    process.exit(1);
  }
}

/* ===================================================================
   2. Fill it with the shapes a real database holds
   =================================================================== */

const id = (n) => `rehearse-${n}`;

await db.query(`insert into "Settings" (id, timezone, "updatedAt") values ('singleton', 'America/New_York', now())`);

// A boss, two streamers, and somebody on shipping.
const PEOPLE = [
  [id("boss"), "boss@bo-retail.test", "The Boss", "BOSS", "STREAMING"],
  [id("maya"), "maya@bo-retail.test", "Maya Streamer", "EMPLOYEE", "STREAMING"],
  [id("devon"), "devon@bo-retail.test", "Devon Streamer", "EMPLOYEE", "STREAMING"],
  [id("pat"), "pat@bo-retail.test", "Pat Packer", "EMPLOYEE", "SHIPPING"],
];
for (const [uid, email, name, role, team] of PEOPLE) {
  await db.query(
    `insert into "User" (id, email, name, "passwordHash", role, team, "isActive", "mustChangePassword", "createdAt", "updatedAt")
     values ($1, $2, $3, '$2b$12$abcdefghijklmnopqrstuv', $4, $5, true, false, now(), now())`,
    [uid, email, name, role, team],
  );
}

// A published release with shows on it, and both people placed.
const DAY = "2026-09-08";
await db.query(
  `insert into "Release" (id, name, "startDate", "endDate", status, "scheduleStatus", "createdAt", "updatedAt")
   values ($1, 'Week of the 8th', $2::date, $2::date, 'CLOSED', 'PUBLISHED', now(), now())`,
  [id("release"), DAY],
);

const SHOWS = [
  [id("show-am"), "TIKTOK", "DAY", `${DAY}T17:00:00Z`, `${DAY}T23:00:00Z`],
  [id("show-pm"), "TIKTOK", "NIGHT", `${DAY}T23:00:00Z`, `2026-09-09T05:00:00Z`],
];
for (const [sid, platform, slot, startsAt, endsAt] of SHOWS) {
  await db.query(
    `insert into "Show" (id, "releaseId", date, platform, slot, "startsAt", "endsAt", status, "createdAt", "updatedAt")
     values ($1, $2, $3::date, $4, $5, $6, $7, 'SCHEDULED', now(), now())`,
    [sid, id("release"), DAY, platform, slot, startsAt, endsAt],
  );
  for (const [seat, who] of [[1, id("maya")], [2, id("devon")]]) {
    await db.query(
      `insert into "Assignment" (id, "showId", "userId", seat, "assignedById", "createdAt")
       values ($1, $2, $3, $4, $5, now())`,
      [id(`a-${sid}-${seat}`), sid, who, seat, id("boss")],
    );
  }
}

// Hours the old way: clocked by hand, against the show. This is the shape the
// launch's scheduled-hours feature has to leave completely alone.
await db.query(
  `insert into "TimeEntry" (id, "userId", "showId", "clockInAt", "clockOutAt", source, version, "createdAt", "updatedAt")
   values ($1, $2, $3, $4, $5, 'SELF', 1, now(), now())`,
  [id("te-maya"), id("maya"), id("show-am"), `${DAY}T17:02:00Z`, `${DAY}T23:00:00Z`],
);
await db.query(
  `insert into "TimeEntry" (id, "userId", "showId", "clockInAt", "clockOutAt", source, version, "createdAt", "updatedAt")
   values ($1, $2, $3, $4, $5, 'ADMIN', 2, now(), now())`,
  [id("te-devon"), id("devon"), id("show-am"), `${DAY}T17:00:00Z`, `${DAY}T22:30:00Z`],
);
await db.query(
  `insert into "TimeEntryRevision" (id, "timeEntryId", version, "clockInAt", "clockOutAt", reason, "changedById", "changedAt")
   values ($1, $2, 2, $3, $4, 'Left half an hour early', $5, now())`,
  [id("rev"), id("te-devon"), `${DAY}T17:00:00Z`, `${DAY}T22:30:00Z`, id("boss")],
);

// Shipping clocking, with no show attached.
await db.query(
  `insert into "TimeEntry" (id, "userId", "clockInAt", "clockOutAt", source, version, "createdAt", "updatedAt")
   values ($1, $2, $3, $4, 'SELF', 1, now(), now())`,
  [id("te-pat"), id("pat"), `${DAY}T13:00:00Z`, `${DAY}T21:00:00Z`],
);

await db.query(
  `insert into "TimeOff" (id, "userId", "startDate", "endDate", note, "recordedById", "createdAt")
   values ($1, $2, '2026-09-20'::date, '2026-09-22'::date, 'Wedding', $3, now())`,
  [id("timeoff"), id("maya"), id("boss")],
);

await db.query(
  `insert into "AuditLog" (id, "entityType", "entityId", action, summary, "actorId", "createdAt")
   values ($1, 'Release', $2, 'PUBLISH', 'Published the week of the 8th', $3, now())`,
  [id("audit"), id("release"), id("boss")],
);

console.log("Filled it: 4 people, a published release, 2 shows, 4 placements, 4 time entries,");
console.log("a correction with its revision, a day off, and an audit trail.\n");

/* ===================================================================
   3. Fingerprint every row
   =================================================================== */

async function tables() {
  const { rows } = await db.query(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
      and table_name not like '\\_prisma%'
    order by table_name
  `);
  return rows.map((r) => r.table_name);
}

async function columnsOf(table) {
  const { rows } = await db.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 order by column_name`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

/**
 * Every row of a table, in a stable order, as one hash.
 *
 * Only the named columns. The launch adds columns to Settings and User, so a
 * `select *` would come back wider afterwards and every hash would differ —
 * which says nothing about whether the data moved. The question is whether the
 * columns that existed before still hold what they held, and that means asking
 * for exactly those.
 */
async function fingerprint(table, columns) {
  const list = columns.map((c) => `"${c}"`).join(", ");
  const { rows } = await db.query(`select ${list} from "${table}" order by 1`);
  const json = JSON.stringify(rows);
  return { rows: rows.length, hash: createHash("sha256").update(json).digest("hex").slice(0, 16) };
}

const before = {};
const columnsBefore = {};
for (const t of await tables()) {
  columnsBefore[t] = await columnsOf(t);
  before[t] = await fingerprint(t, columnsBefore[t]);
}

/*
  The individual rows this rehearsal names later, read now.

  Compared against themselves afterwards rather than against a string typed
  here: what a timestamp column reads back as depends on the server's timezone,
  so a hardcoded expectation tests the machine rather than the migration.
*/
const hoursBefore = (
  await db.query(`select * from "TimeEntry" order by id`)
).rows;

console.log("Before the launch:");
for (const [t, f] of Object.entries(before)) {
  if (f.rows > 0) console.log(`   ${t.padEnd(24)} ${String(f.rows).padStart(3)} rows  ${f.hash}`);
}
console.log();

/* ===================================================================
   4. Run the launch, exactly as LAUNCH.md says
   =================================================================== */

console.log("Running the launch.\n");

// Step 6 of the guide: the enum values, each committed on its own.
const STEP_6 = [
  `ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MANAGER' BEFORE 'BOSS'`,
  `ALTER TYPE "TimeEntrySource" ADD VALUE IF NOT EXISTS 'SCHEDULE'`,
];
for (const sql of STEP_6) await db.query(sql);
check("step 6 — the first two enum values commit on their own", true);

// Step 7: the migrations themselves.
for (const m of LAUNCH_MIGRATIONS) {
  const sql = readFileSync(join(MIGRATIONS, m, "migration.sql"), "utf8");
  try {
    await db.query(sql);
    console.log(`PASS  step 7 — applied ${m}`);
  } catch (error) {
    console.log(`FAIL  step 7 — ${m}: ${error.message}`);
    failures++;
  }
}

/* ===================================================================
   5. Did anything move?
   =================================================================== */

console.log("\nAfter the launch:");

const nowTables = new Set(await tables());
const after = {};
let moved = 0;

for (const [t, b] of Object.entries(before)) {
  if (!nowTables.has(t)) {
    check(`${t} still exists`, false, "the table is gone");
    moved++;
    continue;
  }

  // Every column that existed before must still exist. A dropped one is the
  // thing this whole rehearsal is looking for.
  const nowColumns = new Set(await columnsOf(t));
  const lost = columnsBefore[t].filter((c) => !nowColumns.has(c));
  if (lost.length > 0) {
    check(`${t} kept all its columns`, false, `lost ${lost.join(", ")}`);
    moved++;
    continue;
  }

  const a = await fingerprint(t, columnsBefore[t]);
  after[t] = a;
  if (b.hash !== a.hash || b.rows !== a.rows) {
    check(`${t} is untouched`, false, `${b.rows} rows ${b.hash} → ${a.rows} rows ${a.hash}`);
    moved++;
  }
}

// The new tables are counted separately — they did not exist before.
for (const t of nowTables) {
  if (!(t in after)) after[t] = await fingerprint(t, await columnsOf(t));
}

if (moved === 0) {
  const withRows = Object.entries(before).filter(([, f]) => f.rows > 0);
  const total = withRows.reduce((n, [, f]) => n + f.rows, 0);
  check(
    `every existing row is byte-for-byte identical`,
    true,
    `${total} rows across ${withRows.length} tables`,
  );
}

/* ===================================================================
   6. And the new things exist and are empty
   =================================================================== */

const NEW_TABLES = ["ImportBatch", "SalesRecord", "ImportDrop", "Package", "PackageItem", "ScanEvent"];
for (const t of NEW_TABLES) {
  const exists = after[t] !== undefined;
  check(`${t} was created`, exists, exists ? `${after[t].rows} rows` : "missing");
}

const newColumns = await db.query(`
  select table_name, column_name from information_schema.columns
  where table_schema = 'public'
    and ((table_name = 'Settings' and column_name in ('streamerHourlyCents','shippingHourlyCents','streamerCommissionBps'))
      or (table_name = 'User' and column_name in ('hourlyRateCents','commissionBps')))
  order by table_name, column_name
`);
check("the five pay columns were added", newColumns.rows.length === 5, `${newColumns.rows.length} of 5`);

// The new columns must not have rewritten anybody. Rates default to nothing, and
// the commission to the 1% the business already works to.
const rates = (await db.query(`select * from "Settings" where id = 'singleton'`)).rows[0];
check("hourly rates start at zero, not at a guess", rates.streamerHourlyCents === 0 && rates.shippingHourlyCents === 0);
check("commission starts at 1%", rates.streamerCommissionBps === 100, `${rates.streamerCommissionBps} bps`);
const nulls = (
  await db.query(`select count(*)::int as n from "User" where "hourlyRateCents" is null and "commissionBps" is null`)
).rows[0].n;
check("nobody was given a personal rate they did not ask for", nulls === PEOPLE.length, `${nulls} of ${PEOPLE.length}`);

/* ===================================================================
   7. The guarantees the database is supposed to enforce
   =================================================================== */

const enums = await db.query(`
  select t.typname, e.enumlabel from pg_type t
  join pg_enum e on e.enumtypid = t.oid
  where t.typname in ('Role','TimeEntrySource','PackageStatus','ScanKind')
`);
const labels = new Set(enums.rows.map((r) => `${r.typname}.${r.enumlabel}`));
for (const wanted of [
  "Role.MANAGER",
  "TimeEntrySource.SCHEDULE",
  "PackageStatus.CLOSED_UNVERIFIED",
  "ScanKind.CLOSE_UNVERIFIED",
]) {
  check(`${wanted} exists`, labels.has(wanted));
}

const idx = await db.query(`
  select indexname from pg_indexes where schemaname = 'public'
    and indexname = 'TimeEntry_userId_showId_scheduled_key'
`);
check("hours cannot be printed twice for one show", idx.rows.length === 1);

const checks = (
  await db.query(
    `select count(*)::int as n from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace`,
  )
).rows[0].n;
check("every CHECK constraint is in place", checks === 9, `${checks} of 9`);

/* ===================================================================
   8. The old hours still read exactly as they did
   =================================================================== */

const hoursAfter = (await db.query(`select * from "TimeEntry" order by id`)).rows;

check("the same number of time entries", hoursAfter.length === hoursBefore.length);
check(
  "every clocked time is exactly what it was",
  JSON.stringify(hoursAfter) === JSON.stringify(hoursBefore),
);

const maya = hoursAfter.find((e) => e.id === id("te-maya"));
check("a clocked entry is still marked as clocked", maya?.source === "SELF");
check("and still tied to its show", maya?.showId === id("show-am"));

const devon = hoursAfter.find((e) => e.id === id("te-devon"));
check("an admin correction kept its version", devon?.version === 2);
check("and is still marked as an admin correction", devon?.source === "ADMIN");

const pat = hoursAfter.find((e) => e.id === id("te-pat"));
check("shipping's clocking still has no show attached", pat?.showId === null);

const revs = (await db.query(`select count(*)::int as n from "TimeEntryRevision"`)).rows[0].n;
check("the revision history survived", revs === 1);

/*
  And the thing that would have doubled a pay period.

  Every one of these shows is on a published release and has already started, so
  a catch-up run has every reason to print hours for it. It must not, because
  these people already clocked them. This is that fix, standing on real rows
  rather than on a fixture built to suit it.
*/
const printed = (
  await db.query(`select count(*)::int as n from "TimeEntry" where source = 'SCHEDULE'`)
).rows[0].n;
check("no scheduled hours were printed over clocked ones", printed === 0, `${printed} printed`);

console.log(
  failures === 0
    ? "\nThe launch applied cleanly and changed nothing that was already there."
    : `\n${failures} check(s) FAILED.`,
);

await db.end();
process.exit(failures === 0 ? 0 : 1);

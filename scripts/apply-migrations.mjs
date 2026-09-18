/**
 * Applies pending migrations over the `pg` driver, when the Prisma CLI cannot
 * reach the database but everything else can.
 *
 * Prisma's migration engine is a separate executable that makes its own network
 * connections. On a machine where a firewall or an antivirus lets `node.exe`
 * out but not that binary, `prisma migrate status` reports P1001 "can't reach
 * database server" while the same connection string works perfectly from Node —
 * which is a confusing way to be told the database is fine.
 *
 * `migrate deploy` does three things and no more: work out which migrations are
 * missing, run each one's SQL, and record it. This does exactly those three,
 * over the connection that works.
 *
 * The bookkeeping is byte-identical to Prisma's. The checksum is a SHA-256 of
 * the migration file, which was verified against all eighteen rows Prisma had
 * already written on the development database before this was trusted with
 * anything. So `prisma migrate status` agrees with the result afterwards, and
 * the next ordinary deploy carries on as though nothing unusual happened.
 *
 *   node scripts/apply-migrations.mjs             what would happen
 *   node scripts/apply-migrations.mjs --confirm   do it
 */
import "dotenv/config";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const confirm = process.argv.includes("--confirm");

/*
  Enum values that a later statement in the same migration depends on.

  PostgreSQL refuses to *use* an enum value that was added in the same
  transaction. The scheduled-hours migration adds TimeEntrySource.SCHEDULE and
  then creates an index with `WHERE source = 'SCHEDULE'`, so that value has to
  be committed first or the whole migration fails.

  Only types that already exist can be pre-committed, which is the part that is
  easy to get wrong: PackageStatus and ScanKind are *created* by the shipping
  migration, so touching them here fails with "type does not exist". Values are
  added to them later, but nothing uses those values in the same migration, so
  they need no special handling at all.

  Listed here anyway, and a missing type is skipped rather than fatal. That way
  this is correct whether it runs before the migrations, after them, or twice.
*/
const ENUM_VALUES = [
  `ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MANAGER' BEFORE 'BOSS'`,
  `ALTER TYPE "TimeEntrySource" ADD VALUE IF NOT EXISTS 'SCHEDULE'`,
  `ALTER TYPE "PackageStatus" ADD VALUE IF NOT EXISTS 'CLOSED_UNVERIFIED'`,
  `ALTER TYPE "ScanKind" ADD VALUE IF NOT EXISTS 'CLOSE_UNVERIFIED'`,
  `ALTER TYPE "ScanKind" ADD VALUE IF NOT EXISTS 'ITEM_PLACEHOLDER'`,
  // Used by the split migration, the file after the one that adds it.
  `ALTER TYPE "ImportStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED'`,
];

/** 42704: the type is not there yet. A migration below creates it. */
const UNDEFINED_OBJECT = "42704";

/*
  The direct endpoint, not the pooler — the same rule as prisma.config.ts, and
  for the same reason: migrations do not belong on a transaction pooler. Neon's
  direct endpoint is the pooled host without "-pooler", so it is derived rather
  than needing a second secret kept in step. DIRECT_URL still wins if it is set.
*/
const url = process.env.DIRECT_URL || process.env.DATABASE_URL?.replace("-pooler.", ".");

/*
  Both set, pointing at different databases.

  The trap this is here for: DATABASE_URL changed to production for the launch,
  DIRECT_URL left on this computer's database. DIRECT_URL wins, so the
  migrations run against the laptop, find nothing to do, report success — and
  production is never touched, while every check pointed at DATABASE_URL says
  production is fine. It happened in the launch rehearsal. So it is refused.
*/
if (process.env.DIRECT_URL && process.env.DATABASE_URL) {
  const hostOf = (u) => new URL(u).hostname.replace("-pooler.", ".");
  const direct = hostOf(process.env.DIRECT_URL);
  const pooled = hostOf(process.env.DATABASE_URL);
  if (direct !== pooled) {
    console.error(
      `\nREFUSED. DATABASE_URL points at ${pooled} but DIRECT_URL points at ${direct}.\n` +
        `Migrations would run against ${direct}. They have to be the same database.\n\n` +
        `Delete the DIRECT_URL line from .env (it is worked out from DATABASE_URL) and run this again.\n`,
    );
    process.exit(1);
  }
}

if (!url) {
  console.error("Neither DIRECT_URL nor DATABASE_URL is set in this window.");
  process.exit(1);
}

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

const db = new Client({ connectionString: url, connectionTimeoutMillis: 30_000 });
await db.connect();
console.log(`Connected to ${new URL(url).hostname}\n`);

/* ------------------------------------------------- what is already applied */

/*
  A database with no ledger at all.

  This one's schema was built by `db push` or by running schema.sql, not by
  `migrate deploy`, so Prisma has no record of what is applied — and the CLI
  reports that as "can't reach database server", which sends you looking for a
  network fault that is not there.

  The fix is to write down what is already true: record the migrations whose
  objects are demonstrably present, without running them, and then apply the
  rest normally. That is only honest if the live schema really is the shape
  those migrations produce, which `compare-to-expected.mjs` checks object by
  object. So this refuses to guess and points at that first.
*/
const CUTOFF = "20260909120000_shipping_boxes_and_imports";
const baseline = process.argv.includes("--baseline");

const { rows: ledgerExists } = await db.query(`select to_regclass('_prisma_migrations') as t`);

if (ledgerExists[0].t === null) {
  console.log("This database has no migration history — no _prisma_migrations table.\n");
  console.log("Its schema was built some other way (db push, or schema.sql by hand).");
  console.log("Nothing is wrong with it; Prisma simply has no record of what is applied.\n");

  if (!baseline) {
    console.log("Before recording anything, prove the schema is what the migrations describe:\n");
    console.log("   node scripts/compare-to-expected.mjs\n");
    console.log("If that reports no differences, come back with:\n");
    console.log("   node scripts/apply-migrations.mjs --baseline --confirm\n");
    await db.end();
    process.exit(0);
  }

  if (!confirm) {
    console.log("Add --confirm as well to write the ledger.");
    await db.end();
    process.exit(0);
  }

  console.log("Creating the ledger and recording what is already there.\n");
  await db.query(`
    create table _prisma_migrations (
      id varchar(36) primary key,
      checksum varchar(64) not null,
      finished_at timestamptz,
      migration_name varchar(255) not null,
      logs text,
      rolled_back_at timestamptz,
      started_at timestamptz not null default now(),
      applied_steps_count integer not null default 0
    )
  `);

  const already = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .filter((m) => m < CUTOFF);

  for (const name of already) {
    const bytes = readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"));
    await db.query(
      `insert into _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
       values ($1, $2, $3, now(), now(), 1)`,
      [randomUUID(), createHash("sha256").update(bytes).digest("hex"), name],
    );
    console.log(`   recorded  ${name}`);
  }
  console.log(`\n${already.length} migration(s) recorded as already applied. Nothing was run.\n`);
}

const { rows: applied } = await db.query(
  `select migration_name, finished_at, rolled_back_at from _prisma_migrations order by started_at`,
);

const unfinished = applied.filter((m) => !m.finished_at && !m.rolled_back_at);
if (unfinished.length > 0) {
  console.error(
    `REFUSED: ${unfinished.length} migration(s) started and never finished:\n` +
      unfinished.map((m) => `  ${m.migration_name}`).join("\n") +
      `\n\nThat needs looking at before anything else is applied.`,
  );
  await db.end();
  process.exit(1);
}

const done = new Set(applied.filter((m) => m.finished_at).map((m) => m.migration_name));

const onDisk = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const pending = onDisk.filter((m) => !done.has(m));

console.log(`${done.size} migration(s) already applied.`);
if (applied.length > 0) console.log(`Latest: ${applied[applied.length - 1].migration_name}\n`);

if (pending.length === 0) {
  console.log("Nothing to apply. The database is up to date.");
  await db.end();
  process.exit(0);
}

console.log(`${pending.length} pending:`);
for (const m of pending) console.log(`   ${m}`);

if (!confirm) {
  console.log(
    `\nNothing has been changed. To apply them:\n\n` +
      `   node scripts/apply-migrations.mjs --confirm\n`,
  );
  await db.end();
  process.exit(0);
}

/* -------------------------------------------------------------- apply them */

console.log("\nCommitting the enum values that a migration below will use.");
for (const sql of ENUM_VALUES) {
  const type = /ALTER TYPE "(\w+)"/.exec(sql)?.[1] ?? "?";
  const value = /'([A-Z_]+)'/.exec(sql)?.[1] ?? "?";
  try {
    await db.query(sql);
    console.log(`   ok      ${type}.${value}`);
  } catch (error) {
    if (error.code === UNDEFINED_OBJECT) {
      console.log(`   later   ${type} does not exist yet — a migration below creates it`);
    } else {
      throw error;
    }
  }
}

console.log("\nApplying.");
for (const name of pending) {
  const file = join(MIGRATIONS_DIR, name, "migration.sql");
  const bytes = readFileSync(file);
  const checksum = createHash("sha256").update(bytes).digest("hex");

  // Recorded as started before it runs, exactly as Prisma does, so a failure
  // halfway leaves a row saying so rather than no trace at all.
  const rowId = randomUUID();
  await db.query(
    `insert into _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count)
     values ($1, $2, $3, now(), 0)`,
    [rowId, checksum, name],
  );

  try {
    await db.query(bytes.toString("utf8"));
    await db.query(
      `update _prisma_migrations set finished_at = now(), applied_steps_count = 1 where id = $1`,
      [rowId],
    );
    console.log(`   ok  ${name}`);
  } catch (error) {
    await db.query(`update _prisma_migrations set logs = $2 where id = $1`, [rowId, error.message]);
    console.error(`\nFAILED on ${name}:\n  ${error.message}`);
    console.error(
      `\nThe row for it is left unfinished on purpose, so nothing pretends it worked.\n` +
        `Nothing after it was attempted. Send me this message before doing anything else.`,
    );
    await db.end();
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ verify */

const { rows: after } = await db.query(
  `select count(*)::int as n from _prisma_migrations where finished_at is not null`,
);
console.log(`\n${after[0].n} migration(s) applied in total.`);
console.log("The database is up to date.");

await db.end();

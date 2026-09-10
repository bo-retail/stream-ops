/**
 * Is production's schema the one the migrations describe?
 *
 * Production has no `_prisma_migrations` table, so its schema was built by
 * something other than `migrate deploy` — `db push`, or `schema.sql` run by
 * hand. Either is fine, and both leave Prisma with no record of what is applied.
 *
 * Before recording those migrations as applied and adding the new ones, the
 * claim has to be checked rather than assumed: that the live schema is the same
 * shape those migrations produce. If it is, baselining is bookkeeping. If it is
 * not, baselining writes down something untrue and the next migration lands on
 * a database that is not the one it expects.
 *
 * So this rebuilds the expected shape on the scratch database and compares it,
 * object by object, with the live one.
 *
 * READ-ONLY against production. It issues nothing but SELECTs there.
 *
 *   node scripts/compare-to-expected.mjs
 */
import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const liveUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
const scratchUrl = process.env.SHADOW_DATABASE_URL;

if (!liveUrl) {
  console.error("Set DATABASE_URL (or DIRECT_URL) to the database being inspected.");
  process.exit(1);
}
if (!scratchUrl) {
  console.error("Set SHADOW_DATABASE_URL to a scratch database to build the expected shape in.");
  process.exit(1);
}
if (scratchUrl === liveUrl) {
  console.error("REFUSED: the scratch database and the live one are the same.");
  process.exit(1);
}

/** Which migrations to treat as "should already be there". */
const CUTOFF = "20260909120000_shipping_boxes_and_imports";

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const all = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const expected = all.filter((m) => m < CUTOFF);

/* ------------------------------------------- build the expected shape */

const scratchHost = new URL(scratchUrl).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(scratchHost)) {
  console.error(`REFUSED: the scratch database is at "${scratchHost}". This drops its schema.`);
  process.exit(1);
}

const scratch = new Client({ connectionString: scratchUrl });
await scratch.connect();
console.log(`Building the expected shape on the scratch database (${expected.length} migrations).`);
await scratch.query("drop schema if exists public cascade; create schema public;");
for (const m of expected) {
  await scratch.query(readFileSync(join(MIGRATIONS, m, "migration.sql"), "utf8"));
}

/* ------------------------------------------------------ read them both */

const live = new Client({ connectionString: liveUrl, connectionTimeoutMillis: 30_000 });
await live.connect();
console.log(`Reading the live schema at ${new URL(liveUrl).hostname}\n`);

const SHAPE = {
  tables: `
    select table_name as k, '' as v from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
      and table_name not like '\\_prisma%'
    order by 1`,
  columns: `
    select c.table_name || '.' || c.column_name as k,
           c.data_type || ' ' || c.is_nullable || ' ' || coalesce(c.column_default, '-') as v
    from information_schema.columns c
    join information_schema.tables t
      on t.table_name = c.table_name and t.table_schema = c.table_schema
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.table_name not like '\\_prisma%'
    order by 1`,
  enums: `
    select t.typname || '.' || e.enumlabel as k, '' as v
    from pg_type t join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
    order by 1`,
  indexes: `
    select indexname as k, regexp_replace(indexdef, '\\s+', ' ', 'g') as v
    from pg_indexes where schemaname = 'public' and tablename not like '\\_prisma%'
    order by 1`,
  constraints: `
    select conname as k, pg_get_constraintdef(oid) as v
    from pg_constraint where connamespace = 'public'::regnamespace and contype in ('c','f','u','p')
    order by 1`,
};

async function shapeOf(db) {
  const out = {};
  for (const [name, sql] of Object.entries(SHAPE)) {
    const { rows } = await db.query(sql);
    out[name] = new Map(rows.map((r) => [r.k, r.v]));
  }
  return out;
}

const want = await shapeOf(scratch);
const have = await shapeOf(live);

/* ---------------------------------------------------------- compare */

let problems = 0;
let notes = 0;

for (const kind of Object.keys(SHAPE)) {
  const missing = [...want[kind].keys()].filter((k) => !have[kind].has(k));
  const extra = [...have[kind].keys()].filter((k) => !want[kind].has(k));
  const differs = [...want[kind].keys()].filter(
    (k) => have[kind].has(k) && have[kind].get(k) !== want[kind].get(k),
  );

  const clean = missing.length === 0 && extra.length === 0 && differs.length === 0;
  console.log(
    `${clean ? "ok  " : "    "} ${kind.padEnd(12)} ${want[kind].size} expected, ${have[kind].size} live` +
      (clean ? " — identical" : ""),
  );

  // Missing or differing is a real problem: the live database is not the shape
  // the migrations produce, so the next one cannot be trusted to land.
  for (const k of missing) {
    console.log(`  MISSING  ${kind}: ${k}`);
    problems++;
  }
  for (const k of differs) {
    console.log(`  DIFFERS  ${kind}: ${k}`);
    console.log(`             expected  ${want[kind].get(k)}`);
    console.log(`             live      ${have[kind].get(k)}`);
    problems++;
  }
  // Extra is worth seeing but is not necessarily wrong — a database built by
  // `db push` can carry an index Prisma named differently, and anything the
  // business added by hand shows up here too.
  for (const k of extra) {
    console.log(`  extra    ${kind}: ${k}`);
    notes++;
  }
}

console.log();
if (problems === 0) {
  console.log(
    `The live schema matches what those ${expected.length} migrations produce.` +
      (notes > 0 ? ` ${notes} extra object(s) listed above — read them, but they do not block.` : ""),
  );
  console.log("\nSafe to record those migrations as applied, then apply the new ones.");
} else {
  console.log(`${problems} difference(s) that matter. Do not baseline until these are understood.`);
}

await scratch.end();
await live.end();
process.exit(problems === 0 ? 0 : 1);

/**
 * Dumps every table to a timestamped JSON file before a destructive migration.
 *
 * Reads the table list from the database itself rather than a hard-coded list,
 * so it cannot silently skip a table that was added since it was written — the
 * failure mode that makes a backup worthless exactly when it is needed.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { Client } from "pg";

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const { rows: tables } = await db.query(`
  select table_name from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
    and table_name not like '\\_prisma%'
  order by table_name
`);

const dump = {};
let total = 0;

for (const { table_name } of tables) {
  const { rows } = await db.query(`select * from "${table_name}"`);
  dump[table_name] = rows;
  total += rows.length;
  console.log(`${table_name.padEnd(24)} ${rows.length}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
const file = `backup-all-${stamp}.json`;
writeFileSync(file, JSON.stringify(dump, null, 2));

console.log(`\n${total} rows across ${tables.length} tables saved to ${file}`);
await db.end();

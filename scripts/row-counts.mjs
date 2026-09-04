// Local-dev helper: row counts for every public table.
import "dotenv/config";
import { Client } from "pg";

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(
  "select tablename from pg_tables where schemaname='public' order by tablename",
);
let total = 0;
for (const { tablename } of rows) {
  const r = await c.query(`select count(*)::int as n from "${tablename}"`);
  total += r.rows[0].n;
  console.log(`${tablename}: ${r.rows[0].n}`);
}
console.log(`TOTAL ROWS: ${total}`);
await c.end();

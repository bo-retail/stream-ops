/**
 * Dumps the tables a migration is about to drop into a timestamped JSON file.
 * Cheap insurance: a DROP TABLE cannot be undone, and "it was only demo data"
 * is a judgement best made with the data still in hand.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { Client } from "pg";

const TABLES = [
  "ShowSlot",
  "Assignment",
  "Availability",
  "SalesEntry",
  "SalesEntryRevision",
  "PayrollRun",
  "PayrollAdjustment",
];

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const dump = {};
let total = 0;
for (const table of TABLES) {
  try {
    const { rows } = await c.query(`select * from "${table}"`);
    dump[table] = rows;
    total += rows.length;
    console.log(`${table.padEnd(22)} ${rows.length}`);
  } catch {
    console.log(`${table.padEnd(22)} (already gone)`);
  }
}
await c.end();

const file = `backup-dropped-tables-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`;
writeFileSync(file, JSON.stringify(dump, null, 2));
console.log(`\n${total} rows saved to ${file}`);

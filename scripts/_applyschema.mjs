import { Client } from "pg";
import { readFileSync } from "node:fs";

const db = new Client({ connectionString: process.argv[2] });
await db.connect();
await db.query("drop schema if exists public cascade; create schema public;");

try {
  await db.query(readFileSync("prisma/schema.sql", "utf8"));
  console.log("schema.sql applied cleanly to an empty database.");
} catch (e) {
  console.log("FAILED: " + e.message);
  process.exit(1);
}

const q = async (s) => (await db.query(s)).rows;
const t = await q(
  `select count(*)::int n from information_schema.tables where table_schema='public'`,
);
const c = await q(
  `select count(*)::int n from pg_constraint where contype='c' and connamespace='public'::regnamespace`,
);
const i = await q(
  `select count(*)::int n from pg_indexes where schemaname='public' and indexdef like '%WHERE%'`,
);
console.log(`tables: ${t[0].n}   check constraints: ${c[0].n}   partial indexes: ${i[0].n}`);

await db.end();

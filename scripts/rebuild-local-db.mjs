// Local-dev helper: drops and recreates the empty `public` schema.
//
// The bundled `prisma dev` server serves one physical store for every database
// name, so it cannot provide the separate shadow database that `prisma migrate
// dev` requires. Migrations are therefore authored with `prisma migrate diff`
// and applied with `prisma migrate deploy`, and this script gives that flow a
// clean slate. Refuses to run against anything that is not localhost.
import "dotenv/config";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");

const host = new URL(url.replace(/^postgres(ql)?:/, "http:")).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  throw new Error(`Refusing to run against a non-local host: ${host}`);
}

const c = new Client({ connectionString: url });
await c.connect();
const { rows } = await c.query("select tablename from pg_tables where schemaname='public'");
let total = 0;
for (const { tablename } of rows) {
  const r = await c.query(`select count(*)::int as n from "${tablename}"`);
  total += r.rows[0].n;
}
console.log(`Local database at ${host}: ${rows.length} tables, ${total} rows.`);

await c.query("drop schema if exists public cascade");
await c.query("create schema public");
await c.end();
console.log("public schema recreated — run `npx prisma migrate deploy` next.");

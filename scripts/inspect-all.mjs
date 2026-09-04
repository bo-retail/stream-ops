// Local-dev helper: lists every database on the dev server and what it contains.
import "dotenv/config";
import { Client } from "pg";

const base = process.env.DATABASE_URL.replace(/\/[^/?]+(\?.*)?$/, "");
const suffix = process.env.DATABASE_URL.includes("?") ? process.env.DATABASE_URL.slice(process.env.DATABASE_URL.indexOf("?")) : "";

const admin = new Client({ connectionString: `${base}/template1${suffix}` });
await admin.connect();
const dbs = await admin.query("select datname from pg_database where datistemplate = false");
await admin.end();

for (const { datname } of dbs.rows) {
  const c = new Client({ connectionString: `${base}/${datname}${suffix}` });
  try {
    await c.connect();
    const t = await c.query("select tablename from pg_tables where schemaname='public'");
    const names = t.rows.map((r) => r.tablename);
    const ledger = names.includes("_prisma_migrations")
      ? (await c.query("select migration_name from _prisma_migrations")).rows.map((r) => r.migration_name)
      : null;
    console.log(`${datname}: ${names.length} tables${ledger ? ` | ledger: ${ledger.join(", ") || "(empty)"}` : " | no ledger"}`);
    await c.end();
  } catch (e) {
    console.log(`${datname}: <${e.message}>`);
  }
}

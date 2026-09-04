// One-off helper: checks that a Neon connection string works and reports the
// server version. Takes the URL as an argument so nothing is written to disk
// until it is known good.
import { Client } from "pg";

const url = process.argv[2];
if (!url) {
  console.error("Usage: node scripts/test-neon.mjs <connection-string>");
  process.exit(1);
}

const c = new Client({ connectionString: url, connectionTimeoutMillis: 30_000 });
try {
  await c.connect();
  const { rows } = await c.query("select version() as v, current_database() as db");
  console.log("OK");
  console.log("  database:", rows[0].db);
  console.log("  version :", rows[0].v.split(",")[0]);
  const { rows: t } = await c.query(
    "select count(*)::int as n from pg_tables where schemaname = 'public'",
  );
  console.log("  tables  :", t[0].n);
  await c.end();
} catch (error) {
  console.log("FAILED:", error.message);
  process.exit(1);
}

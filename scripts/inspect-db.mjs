// Local-dev helper: prints which tables exist and which migrations are recorded.
import "dotenv/config";
import { Client } from "pg";

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const tables = await c.query(
  "select tablename from pg_tables where schemaname='public' order by tablename",
);
console.log("tables:", tables.rows.map((r) => r.tablename).join(", ") || "(none)");
try {
  const migrations = await c.query(
    "select migration_name, finished_at from _prisma_migrations order by started_at",
  );
  console.log("migrations:", migrations.rows.map((r) => r.migration_name).join(", ") || "(none)");
} catch {
  console.log("migrations: _prisma_migrations table missing");
}
await c.end();

// Local-dev helper: creates the app + shadow databases on the `prisma dev` server.
// Not used in production — Neon databases are created in the Neon console.
import { Client } from "pg";

const admin =
  process.env.ADMIN_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:51214/template1?sslmode=disable";

const c = new Client({ connectionString: admin });
await c.connect();
for (const db of ["streamops", "streamops_shadow"]) {
  const { rowCount } = await c.query("select 1 from pg_database where datname = $1", [db]);
  if (rowCount === 0) {
    await c.query(`create database "${db}"`);
    console.log("created", db);
  } else {
    console.log("exists", db);
  }
}
await c.end();

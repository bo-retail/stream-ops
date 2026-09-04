// Local-dev helper: empties the Prisma shadow database.
//
// The shadow database is scratch space Prisma owns for diffing migrations — it
// holds no application data and must be empty before `migrate dev` will run.
// This never touches DATABASE_URL.
import "dotenv/config";
import { Client } from "pg";

const url = process.env.SHADOW_DATABASE_URL;
if (!url) throw new Error("SHADOW_DATABASE_URL is not set.");
if (!/shadow/i.test(url)) {
  throw new Error("Refusing to run: SHADOW_DATABASE_URL does not look like a shadow database.");
}

const c = new Client({ connectionString: url });
await c.connect();
await c.query("drop schema if exists public cascade");
await c.query("create schema public");
await c.end();
console.log("shadow database emptied");

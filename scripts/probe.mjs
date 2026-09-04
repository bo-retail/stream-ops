// Local-dev helper: checks whether the dev server actually isolates databases.
import "dotenv/config";
import { Client } from "pg";

const main = process.env.DATABASE_URL;
const shadow = process.env.SHADOW_DATABASE_URL;

const a = new Client({ connectionString: main });
await a.connect();
await a.query("drop table if exists probe_marker");
await a.query("create table probe_marker (id int)");
const whichA = await a.query("select current_database() as db");
await a.end();

const b = new Client({ connectionString: shadow });
await b.connect();
const whichB = await b.query("select current_database() as db");
const seen = await b.query("select tablename from pg_tables where tablename = 'probe_marker'");
await b.end();

console.log("main reports current_database =", whichA.rows[0].db);
console.log("shadow reports current_database =", whichB.rows[0].db);
console.log("marker created in main is visible from shadow:", seen.rowCount > 0);

const c = new Client({ connectionString: main });
await c.connect();
await c.query("drop table if exists probe_marker");
await c.end();

/**
 * Wakes a sleeping Neon compute, and waits for it.
 *
 * Neon's free plan scales the database to zero after a few idle minutes. The
 * next thing to connect wakes it, but waking takes a few seconds and some
 * clients give up first — `prisma migrate status` reports P1001 "can't reach
 * database server", which reads like the database is gone rather than asleep.
 *
 * So this connects with a long patience and retries, and says plainly what is
 * happening. Run it before any Prisma command if the database has been idle.
 *
 *   node scripts/wake.mjs
 */
import "dotenv/config";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set in this window.");
  process.exit(1);
}

console.log(`Waking ${new URL(url).hostname}`);
console.log("A sleeping Neon compute takes a few seconds. Retrying until it answers.\n");

const ATTEMPTS = 10;

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const db = new Client({ connectionString: url, connectionTimeoutMillis: 30_000 });
  try {
    await db.connect();
    const { rows } = await db.query("select version() as v, current_database() as d");
    await db.end();
    console.log(`Awake on attempt ${attempt}.`);
    console.log(`  database  ${rows[0].d}`);
    console.log(`  ${rows[0].v.split(",")[0]}`);
    console.log("\nRun your next command now, while it is still awake.");
    process.exit(0);
  } catch (error) {
    await db.end().catch(() => {});
    console.log(`  attempt ${attempt} of ${ATTEMPTS}: ${error.message}`);
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
  }
}

console.error("\nStill not answering after 10 tries. Check the Neon console — the project may be suspended.");
process.exit(1);

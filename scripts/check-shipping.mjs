/**
 * Proves the database refuses the things the shipping screens say are impossible.
 *
 * The same argument as `check-constraints.mjs`: application checks can be
 * bypassed by a race, a script, or a future bug. These hold regardless. Every
 * attempt below is rolled back, and the fixtures are removed at the end.
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { Client } from "pg";

assertDevDatabase("check-shipping.mjs");

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let failures = 0;

/** Runs a statement that must fail, inside a transaction that is rolled back. */
async function mustReject(name, sql, params = []) {
  await db.query("begin");
  try {
    await db.query(sql, params);
    console.log(`FAIL  ${name} — the database allowed it`);
    failures++;
  } catch (error) {
    const kind =
      error.code === "23505"
        ? "unique violation"
        : error.code === "23514"
          ? "check violation"
          : error.code === "23503"
            ? "foreign key violation"
            : `error ${error.code}`;
    console.log(`PASS  ${name} — rejected (${kind})`);
  } finally {
    await db.query("rollback");
  }
}

/** Runs a statement that must succeed, inside a transaction that is rolled back. */
async function mustAllow(name, sql, params = []) {
  await db.query("begin");
  try {
    await db.query(sql, params);
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name} — ${error.code} ${error.message}`);
    failures++;
  } finally {
    await db.query("rollback");
  }
}

const { rows: people } = await db.query(
  `select id from "User" where "isActive" order by "createdAt" limit 1`,
);
if (people.length < 1) {
  console.log("SKIP  need at least one account to attribute a scan to.");
  await db.end();
  process.exit(0);
}
const packer = people[0].id;

const FIXTURE_DATE = "2099-12-31";
const TRACKING = "9999999999999999999999";

const batchRow = await db.query(
  `insert into "ImportBatch" (id, "showDate", status, "uploadedAt", files, flags)
   values (gen_random_uuid()::text, $1::date, 'OK', now(), '[]'::jsonb, '[]'::jsonb)
   returning id`,
  [FIXTURE_DATE],
);
const batch = batchRow.rows[0].id;

const packageRow = await db.query(
  `insert into "Package" (id, "trackingNumber", platform, "showDate", buyer, "batchId", "createdAt", "updatedAt")
   values (gen_random_uuid()::text, $1, 'TIKTOK', $2::date, 'fixture.buyer', $3, now(), now())
   returning id`,
  [TRACKING, FIXTURE_DATE, batch],
);
const box = packageRow.rows[0].id;

await db.query(
  `insert into "PackageItem" (id, "packageId", "stockNumber", "expectedQty", "scannedQty")
   values (gen_random_uuid()::text, $1, '49746', 3, 0)`,
  [box],
);

console.log("Testing against a purpose-built box.\n");

/* ------------------------------------------------------------- the box */

// This is what makes a box closed for everyone: two packers scanning the same
// label cannot end up with two boxes to close independently.
await mustReject(
  "two boxes cannot share a tracking number",
  `insert into "Package" (id, "trackingNumber", platform, "showDate", "createdAt", "updatedAt")
   values (gen_random_uuid()::text, $1, 'EBAY', $2::date, now(), now())`,
  [TRACKING, FIXTURE_DATE],
);

await mustReject(
  "a stock number cannot appear twice in one box",
  `insert into "PackageItem" (id, "packageId", "stockNumber", "expectedQty", "scannedQty")
   values (gen_random_uuid()::text, $1, '49746', 1, 0)`,
  [box],
);

await mustReject(
  "an expected count cannot be negative",
  `update "PackageItem" set "expectedQty" = -1 where "packageId" = $1`,
  [box],
);

await mustReject(
  "a scanned count cannot be negative",
  `update "PackageItem" set "scannedQty" = -1 where "packageId" = $1`,
  [box],
);

// Not a mistake: an unexpected watch added on purpose is recorded as expected 0,
// scanned 1, and the box is marked incomplete. The counts must allow that.
await mustAllow(
  "a scanned count may exceed the expected count, for a deliberate override",
  `insert into "PackageItem" (id, "packageId", "stockNumber", "expectedQty", "scannedQty")
   values (gen_random_uuid()::text, $1, 'NOT-ON-THE-LIST', 0, 1)`,
  [box],
);

/* -------------------------------------------------------- the evidence */

await db.query(
  `insert into "ScanEvent" (id, "packageId", "userId", at, kind, "stockNumber")
   values (gen_random_uuid()::text, $1, $2, now(), 'ITEM_ACCEPTED', '49746')`,
  [box, packer],
);

// Re-uploading a corrected report may drop a box nobody has touched. The moment
// a packer scans one it becomes evidence, and the database stops trusting every
// future caller to remember that.
await mustReject(
  "a box that has been scanned cannot be deleted",
  `delete from "Package" where id = $1`,
  [box],
);

// A scan without a name is not evidence. Accounts are deactivated, never deleted.
await mustReject(
  "somebody who has packed a box cannot be deleted",
  `delete from "User" where id = $1`,
  [packer],
);

// A box outlives the upload that made it: the batch can go, the shipment cannot.
await mustAllow(
  "deleting an upload leaves its boxes standing",
  `delete from "ImportBatch" where id = $1`,
  [batch],
);

const { rows: kept } = await db.query(
  `select count(*)::int as n from "ScanEvent" where "packageId" = $1`,
  [box],
);
console.log(`\nBox still has ${kept[0].n} scan(s) — every attempt above was rolled back.`);

/* ------------------------------------------------------------- cleanup */

await db.query(`delete from "ScanEvent" where "packageId" = $1`, [box]);
await db.query(`delete from "PackageItem" where "packageId" = $1`, [box]);
await db.query(`delete from "Package" where id = $1`, [box]);
await db.query(`delete from "ImportBatch" where id = $1`, [batch]);

const { rows: left } = await db.query(
  `select count(*)::int as n from "Package" where "showDate" = $1::date`,
  [FIXTURE_DATE],
);
console.log(`Fixture removed — ${left[0].n} boxes left on ${FIXTURE_DATE}.`);

await db.end();
console.log(failures === 0 ? "All shipping constraint checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

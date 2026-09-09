/**
 * Proves an upload does what it claims, end to end, against a real database.
 *
 * The parsing is already covered by unit tests. This exercises the half that
 * cannot be: writing a day, uploading the same day again, and the promise that
 * a second upload never disturbs a box somebody has already closed.
 *
 *   STREAMOPS_IMPORT_FIXTURES=<folder with one day's three exports> \
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-import.mts
 *
 * `npx prisma dev` gives you a local database for this with nothing to install.
 *
 * Two things about that invocation. The file is `.mts` because tsx treats a
 * plain `.ts` here as CommonJS, which has no top-level await. And the
 * `react-server` condition is what makes the `server-only` package resolve to
 * its empty module instead of throwing — the guard that keeps these modules out
 * of client bundles also stops a plain Node script importing them.
 *
 * Writes to whatever DATABASE_URL points at, so point it at a scratch database.
 * Everything it creates is removed at the end.
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/db";
import { runImport } from "../src/lib/server/imports";

assertDevDatabase("check-import.mts");

const dir = process.env.STREAMOPS_IMPORT_FIXTURES;
if (!dir || !existsSync(dir)) {
  console.log("SKIP  set STREAMOPS_IMPORT_FIXTURES to a folder holding one day's exports.");
  process.exit(0);
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith(".csv"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
console.log(`Read ${files.length} file(s) from the fixture folder.\n`);

const boss = await prisma.user.findFirst({ where: { isActive: true }, select: { id: true } });
if (!boss) {
  console.log("SKIP  need an account to attribute the upload to. Run the seed first.");
  process.exit(0);
}

/* ------------------------------------------------------------ first upload */

/*
  Whatever is already on this day stays there.

  This script used to assume an empty day and count in absolutes, so it failed
  the moment somebody had uploaded that day through the app — which is exactly
  when you would most want to run it. The counts are taken against a baseline
  instead, and the cleanup at the end removes only what this run created.
*/
const theDay = new Date("2026-09-08T00:00:00.000Z");
const existingBatchIds = (
  await prisma.importBatch.findMany({ where: { showDate: theDay }, select: { id: true } })
).map((b) => b.id);
const existingOk = await prisma.importBatch.count({
  where: { showDate: theDay, status: "OK" },
});
const existingSales = await prisma.salesRecord.count({ where: { showDate: theDay } });
const existingBoxes = await prisma.package.count({ where: { showDate: theDay } });

if (existingBatchIds.length > 0) {
  console.log(
    `${existingBatchIds.length} upload(s) already on 2026-09-08. Counting from there, leaving them alone.\n`,
  );
}

const first = await runImport(files, boss.id);
console.log(`First upload: ${first.status}, ${first.watchCount} watches, ${first.boxCount} boxes.\n`);

check("status is OK", first.status, "OK");
check("show date", first.showDate, "2026-09-08");
check("watches", first.watchCount, 473);
check("boxes", first.boxCount, 220);
check("no blocking flags", first.flags.filter((f) => f.severity === "blocking").length, 0);

const showDate = new Date(`${first.showDate}T00:00:00.000Z`);

check(
  "sales rows written",
  (await prisma.salesRecord.count({ where: { showDate } })) - existingSales,
  473,
);
// Boxes are keyed on the tracking number, so a re-upload updates them rather
// than adding more. The count is absolute either way.
check(
  "boxes written",
  await prisma.package.count({ where: { showDate } }),
  Math.max(220, existingBoxes),
);
check(
  "dropped rows written",
  await prisma.importDrop.count({ where: { batchId: first.batchId! } }),
  17, // 9 TikTok cancels + 7 eBay unpaid + 1 eBay summary row
);

// The box that made the counters-not-a-checklist decision.
const big = await prisma.package.findUnique({
  where: { trackingNumber: "9234690390470910236904" },
  select: { buyer: true, items: { select: { stockNumber: true, expectedQty: true } } },
});
check("the 17-watch box exists", big !== null, true);
check("its buyer", big?.buyer, "mike.honcho059");
check(
  "it expects three of 49746",
  big?.items.find((i) => i.stockNumber === "49746")?.expectedQty,
  3,
);
check(
  "and two of 48080",
  big?.items.find((i) => i.stockNumber === "48080")?.expectedQty,
  2,
);
check(
  "17 watches across its lines",
  big?.items.reduce((n, i) => n + i.expectedQty, 0),
  17,
);

/* -------------------------------------------------- a closed box, then again */

// Close one box, and scan something into it, so the re-upload has something it
// is forbidden to disturb.
const victim = await prisma.package.findFirstOrThrow({
  where: { showDate, status: "OPEN" },
  select: { id: true, trackingNumber: true },
});
await prisma.scanEvent.create({
  data: { packageId: victim.id, userId: boss.id, kind: "LABEL", rawScan: victim.trackingNumber },
});
await prisma.package.update({
  where: { id: victim.id },
  data: { status: "CLOSED_COMPLETE", closedById: boss.id, closedAt: new Date() },
});

console.log("\nClosed one box and scanned its label, then uploaded the same day again.\n");

const second = await runImport(files, boss.id);

check("second upload is OK", second.status, "OK");
check("still 220 boxes, not 440", await prisma.package.count({ where: { showDate } }), 220);
check("it reports the closed box it left alone", second.untouchedClosedBoxes, 1);

const after = await prisma.package.findUniqueOrThrow({
  where: { id: victim.id },
  select: { status: true, closedById: true },
});
check("the closed box is still closed", after.status, "CLOSED_COMPLETE");
check("and still stamped with who closed it", after.closedById === boss.id, true);
check(
  "its scan survived",
  await prisma.scanEvent.count({ where: { packageId: victim.id } }),
  1,
);

check(
  "both uploads are on record",
  (await prisma.importBatch.count({ where: { showDate, status: "OK" } })) - existingOk,
  2,
);
check(
  "sales rows are per batch, not duplicated onto the boxes",
  (await prisma.salesRecord.count({ where: { showDate } })) - existingSales,
  946, // 473 from each upload; the boxes stayed at 220
);

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleaning up.");

// Only this run's uploads. Sales rows cascade from the batch. The boxes go only
// if the day had none before, because a box outlives the upload that created it
// and one that was already here may have been packed against.
await prisma.importBatch.deleteMany({
  where:
    existingBatchIds.length > 0 ? { showDate, id: { notIn: existingBatchIds } } : { showDate },
});
if (existingBoxes === 0) {
  await prisma.scanEvent.deleteMany({ where: { package: { showDate } } });
  await prisma.packageItem.deleteMany({ where: { package: { showDate } } });
  await prisma.package.deleteMany({ where: { showDate } });
}

const leftSales = await prisma.salesRecord.count({ where: { showDate } });
console.log(
  `Removed this run's uploads — ${leftSales} sales row(s) left on ${first.showDate}` +
    (existingSales > 0 ? ` (${existingSales} were here before).` : "."),
);
if (leftSales !== existingSales) {
  console.log(`FAIL  cleanup left ${leftSales} sales rows where ${existingSales} were before.`);
  failures++;
}

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll import checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

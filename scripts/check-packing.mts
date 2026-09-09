/**
 * Walks a box through the scanner, against a real database.
 *
 * Every rule the floor relies on, in the order a packer would hit them: the
 * label opens the box, duplicate barcodes count rather than collide, the fourth
 * one is refused, a watch from another box is refused, a short box will not
 * close by the ordinary route, and the overrides record what really happened.
 *
 *   STREAMOPS_IMPORT_FIXTURES=<folder with one day's three exports> \
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-packing.mts
 *
 * Everything it creates is removed at the end.
 */
import "dotenv/config";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/db";
import { runImport } from "../src/lib/server/imports";
import {
  createUnknownBox,
  getBoxById,
  openBoxByScan,
  overrideItem,
  packItem,
  sealBox,
  unsealBox,
} from "../src/lib/server/packing";
import type { ScanOutcome } from "../src/lib/server/packing";

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

/** The box, whichever shape the outcome came back in. */
function boxOf(outcome: ScanOutcome) {
  return outcome.kind === "box" || outcome.kind === "refused" || outcome.kind === "alreadyPacked"
    ? outcome.box
    : null;
}

const packer = await prisma.user.findFirst({ where: { isActive: true }, select: { id: true } });
if (!packer) {
  console.log("SKIP  need an account to attribute scans to. Run the seed first.");
  process.exit(0);
}

const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith(".csv"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

const imported = await runImport(files, packer.id);
console.log(`Imported ${imported.watchCount} watches into ${imported.boxCount} boxes.\n`);
const showDate = new Date(`${imported.showDate}T00:00:00.000Z`);

/* --------------------------------------------------------------- the label */

// The real scan, prefix and all: 420 + ZIP5 + the 22-digit tracking.
const TRACKING = "9234690390470910236904";
const REAL_SCAN = `42013057${TRACKING}`;

const opened = await openBoxByScan(packer.id, REAL_SCAN);
check("a full label scan opens the box", opened.kind, "box");
const box = boxOf(opened)!;
check("the right box", box.tracking, TRACKING);
check("with 17 watches expected", box.totalExpected, 17);
check("and none in it yet", box.totalScanned, 0);

check("a label that is in no report is not invented", (await openBoxByScan(packer.id, "42013057" + "9999999999999999999999")).kind, "unknownLabel");
check("nor is a scan too short to be a label", (await openBoxByScan(packer.id, "123")).kind, "error");

/* ---------------------------------------------------------------- the items */

// 49746 is in this box three times. This is the case a tick-list gets wrong.
let r = await packItem(packer.id, box.id, "49746");
check("the first of three is accepted", boxOf(r)?.items.find((i) => i.stockNumber === "49746")?.scanned, 1);
r = await packItem(packer.id, box.id, "49746");
check("so is the second", boxOf(r)?.items.find((i) => i.stockNumber === "49746")?.scanned, 2);
r = await packItem(packer.id, box.id, "49746");
check("so is the third", boxOf(r)?.items.find((i) => i.stockNumber === "49746")?.scanned, 3);

r = await packItem(packer.id, box.id, "49746");
check("the fourth is refused", r.kind, "refused");
check("and says why", r.kind === "refused" && r.message.includes("All 3"), true);
check("without changing the count", boxOf(r)?.items.find((i) => i.stockNumber === "49746")?.scanned, 3);

check("case does not matter to a scanner", (await packItem(packer.id, box.id, " 48080 ")).kind, "box");

r = await packItem(packer.id, box.id, "NOT-IN-THIS-BOX");
check("a watch from another box is refused", r.kind, "refused");
check("and named", r.kind === "refused" && r.message.includes("NOT-IN-THIS-BOX"), true);

/* --------------------------------------------------------------- closing up */

r = await sealBox(packer.id, box.id, false);
check("a short box will not close by the ordinary route", r.kind, "refused");
check("and says how it stands", r.kind === "refused" && r.message.includes("Not everything"), true);
check("the box is still open", (await getBoxById(box.id))?.status, "OPEN");

// Fill it properly, then prove the ordinary Close works.
const remaining = (await getBoxById(box.id))!.items.filter((i) => i.outstanding > 0);
for (const item of remaining) {
  for (let n = 0; n < item.outstanding; n++) await packItem(packer.id, box.id, item.stockNumber);
}
const full = await getBoxById(box.id);
check("every watch is in", full?.totalScanned, 17);
check("so the box reads complete", full?.complete, true);

r = await sealBox(packer.id, box.id, false);
check("and it closes cleanly", boxOf(r)?.status, "CLOSED_COMPLETE");

check("rescanning its label says already packed", (await openBoxByScan(packer.id, REAL_SCAN)).kind, "alreadyPacked");
check("and nothing more can go in it", (await packItem(packer.id, box.id, "49746")).kind, "alreadyPacked");

/* ------------------------------------------------------- the two overrides */

const second = await prisma.package.findFirstOrThrow({
  where: { showDate, status: "OPEN", isUnrecognised: false },
  select: { id: true, items: { select: { stockNumber: true, expectedQty: true } } },
});

r = await overrideItem(packer.id, second.id, "GHOST-WATCH-1");
check("a watch can be added against the report", boxOf(r)?.items.some((i) => i.stockNumber === "GHOST-WATCH-1"), true);

// Fill the real lines so the only thing wrong is the extra one.
for (const item of second.items) {
  for (let n = 0; n < item.expectedQty; n++) await packItem(packer.id, second.id, item.stockNumber);
}
r = await sealBox(packer.id, second.id, false);
check("an over-filled box still will not close cleanly", r.kind, "refused");
check("and says why", r.kind === "refused" && r.message.includes("not on the report"), true);

r = await sealBox(packer.id, second.id, true, "one extra was genuinely in the box");
check("closing incomplete works", boxOf(r)?.status, "CLOSED_INCOMPLETE");

/* -------------------------------------------------------- an unknown label */

const UNKNOWN = "9200999888777666555444";
r = await createUnknownBox(packer.id, UNKNOWN);
check("an unrecognised label can still be packed", r.kind, "box");
const ghost = boxOf(r)!;
check("and is flagged as such", ghost.isUnrecognised, true);
r = await packItem(packer.id, ghost.id, "ANY-WATCH");
check("anything scanned into it is accepted", boxOf(r)?.totalScanned, 1);
r = await sealBox(packer.id, ghost.id, false);
check("and it closes on what was actually in it", boxOf(r)?.status, "CLOSED_COMPLETE");

/* ------------------------------------------------------------ the evidence */

const events = await prisma.scanEvent.findMany({
  where: { packageId: box.id },
  select: { kind: true, stockNumber: true },
});
const kinds = events.reduce<Record<string, number>>((acc, e) => {
  acc[e.kind] = (acc[e.kind] ?? 0) + 1;
  return acc;
}, {});

check("the label scan was recorded", kinds.LABEL >= 1, true);
check("all 17 accepted watches were recorded", kinds.ITEM_ACCEPTED, 17);
check("and so were the refusals", kinds.ITEM_REFUSED, 2);
check("closing was recorded", kinds.CLOSE_COMPLETE, 1);
check(
  "a refusal names the watch that was turned away",
  events.some((e) => e.kind === "ITEM_REFUSED" && e.stockNumber === "NOT-IN-THIS-BOX"),
  true,
);

/* ------------------------------------------------------------- reopening */

r = await unsealBox(packer.id, box.id, "x");
check("reopening needs a reason", r.kind, "error");
r = await unsealBox(packer.id, box.id, "customer said the wrong watch arrived");
check("with one, the box reopens", boxOf(r)?.status, "OPEN");
check(
  "and the scan history is untouched",
  await prisma.scanEvent.count({ where: { packageId: box.id } }),
  events.length + 1,
);

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleaning up.");
await prisma.scanEvent.deleteMany({ where: { package: { OR: [{ showDate }, { trackingNumber: UNKNOWN }] } } });
await prisma.packageItem.deleteMany({ where: { package: { OR: [{ showDate }, { trackingNumber: UNKNOWN }] } } });
await prisma.package.deleteMany({ where: { OR: [{ showDate }, { trackingNumber: UNKNOWN }] } });
await prisma.importBatch.deleteMany({ where: { showDate } });
console.log(`Removed — ${await prisma.package.count({ where: { showDate } })} boxes left.`);

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll packing checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * The things you can do to a day's report once it is in: replace it, undo it,
 * and download what the floor did with it.
 *
 *   STREAMOPS_IMPORT_FIXTURES=<folder with one day's three exports> \
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-report-entry.mts
 */
import "dotenv/config";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "../src/lib/db";
import { readFiles, runImport } from "../src/lib/server/imports";
import { openBoxByScan, packItem, sealBox } from "../src/lib/server/packing";
import { deleteImport, listShowDays, reportRemovalImpact } from "../src/lib/server/shipping";
import { buildShippingWorkbook } from "../src/lib/server/shipping-workbook";

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

const user = await prisma.user.findFirst({ where: { isActive: true }, select: { id: true } });
if (!user) {
  console.log("SKIP  need an account. Run the seed first.");
  process.exit(0);
}

const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith(".csv"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

/* ------------------------------------------- reading a day before writing it */

// The upload screen asks which day the files are for. This is what makes that
// a confirmation rather than a guess: the day comes out of the orders, and the
// choice is checked against it.
const preview = readFiles(files);
check("the day is readable without writing anything", preview.showDate, "2026-09-08");

const day = preview.showDate!;
const showDate = new Date(`${day}T00:00:00.000Z`);

/**
 * Start from a known state for this one day.
 *
 * Anything already loaded for it — an earlier run, or somebody trying the app
 * — would make every count below meaningless. Only this fixture day is touched.
 */
async function clearDay() {
  await prisma.scanEvent.deleteMany({ where: { package: { showDate } } });
  await prisma.packageItem.deleteMany({ where: { package: { showDate } } });
  await prisma.package.deleteMany({ where: { showDate } });
  await prisma.importBatch.deleteMany({ where: { showDate } });
}
const before = await prisma.importBatch.count({ where: { showDate } });
await clearDay();
if (before > 0) console.log(`Cleared ${before} existing upload(s) for ${day}.\n`);

check("nothing is loaded for the day now", await prisma.importBatch.count({ where: { showDate } }), 0);

/* --------------------------------------------------------------- undo */

const first = await runImport(files, user.id);
check("a day imports", first.status, "OK");
check("with its boxes", await prisma.package.count({ where: { showDate } }), 220);

const undone = await deleteImport(first.batchId!);
check("an untouched day can be undone without ceremony", undone.ok, true);
check("and its boxes go with it", await prisma.package.count({ where: { showDate } }), 0);
check("as do its sales", await prisma.salesRecord.count({ where: { showDate } }), 0);
check(
  "and its exceptions",
  await prisma.importDrop.count({ where: { batch: { showDate } } }),
  0,
);

/* ------------------------------------------ undo, once somebody has packed */

const second = await runImport(files, user.id);
const opened = await openBoxByScan(user.id, "420130579234690390470910236904");
check("a box opens", opened.kind, "box");
const box = opened.kind === "box" ? opened.box : null;
await packItem(user.id, box!.id, "49746");

// Once anybody has packed, removing the report destroys the scan record for
// those parcels. That is allowed — it is the owner's call — but not by
// accident: it needs a reason, which outlives what it describes.
const refused = await deleteImport(second.batchId!);
check("a day with scans will not go without a reason", refused.ok, false);
check(
  "and says what would be destroyed",
  !refused.ok && refused.reason.includes("scan record"),
  true,
);
check("nothing was removed", await prisma.package.count({ where: { showDate } }), 220);

const tooShort = await deleteImport(second.batchId!, "x");
check("a token reason is not a reason", tooShort.ok, false);

/* -------------------------------------------- re-uploading over the top */

// The gentler alternative, for a mistake caught before anybody packs: upload
// the corrected files instead.
for (const item of box!.items.filter((i) => i.outstanding > 0)) {
  for (let n = 0; n < item.outstanding; n++) await packItem(user.id, box!.id, item.stockNumber);
}
await sealBox(user.id, box!.id, false);

const third = await runImport(files, user.id);
check("re-uploading works even after packing has started", third.status, "OK");
check("still 220 boxes", await prisma.package.count({ where: { showDate } }), 220);
check("and it says what it left alone", third.untouchedClosedBoxes, 1);

/* ------------------------------------------------ what the day is waiting for */

const days = await listShowDays();
const row = days.find((d) => d.dateISO === day);
if (row) {
  check("the day list knows what arrived", row.loadedFiles.length, 3);
  check("and reports it as loaded", row.report?.status, "OK");
} else {
  console.log("SKIP  no published shows on that date, so the day list has nothing to say.");
}

/* ------------------------------------------------- the shipping workbook */

const wbOut = await buildShippingWorkbook(day, day);
check("a shipping workbook was produced", wbOut !== null, true);
check("named for the day", wbOut?.filename, `BO_Retail_Shipping_${day}.xlsx`);
check("covering every box", wbOut?.boxes, 220);

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(wbOut!.buffer);
check("three sheets", wb.worksheets.map((s) => s.name), ["Summary", "Boxes", "Scans"]);

const scans = wb.getWorksheet("Scans")!;
check("every scan is in it", scans.rowCount, wbOut!.scans + 1);
check(
  "including what the label scan was",
  (scans.getRow(2).values as unknown[]).includes("Label scanned"),
  true,
);
const boxesSheet = wb.getWorksheet("Boxes")!;
check("every box is in it", boxesSheet.rowCount, 221);
check("with what it should have held and what went in", (boxesSheet.getRow(1).values as unknown[]).slice(7, 9), ["Expected", "Scanned in"]);

const summarySheet = wb.getWorksheet("Summary")!;
check("and a person on the summary", summarySheet.rowCount >= 5, true);

check("a day with no boxes produces nothing", await buildShippingWorkbook("2000-01-01", "2000-01-01"), null);

/* --------------------------------------- removing it anyway, with a reason */

// The owner's way out. Allowed, but never by accident: it destroys the scan
// record for parcels that have already gone, and the reason outlives it.
const latest = await prisma.importBatch.findFirstOrThrow({
  where: { showDate },
  orderBy: { uploadedAt: "desc" },
  select: { id: true },
});

const impactBefore = await reportRemovalImpact(latest.id);
check("the impact names the packed boxes", impactBefore!.scannedBoxes, 1);
check("and counts the scans that would go with them", impactBefore!.scans > 0, true);

const forced = await deleteImport(latest.id, "wrong day's files, nothing real was packed");
check("with a reason, it goes through", forced.ok, true);
check("the boxes are gone", await prisma.package.count({ where: { showDate } }), 0);
check("so is the scan history", await prisma.scanEvent.count({ where: { package: { showDate } } }), 0);
check("so are the uploads", await prisma.importBatch.count({ where: { showDate } }), 0);
check("and the sales", await prisma.salesRecord.count({ where: { showDate } }), 0);

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleaning up.");
await clearDay();
console.log(`Removed — ${await prisma.package.count({ where: { showDate } })} boxes left.`);

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll report-entry checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

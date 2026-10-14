/**
 * The starting count, against a real database (Samuel, 10/14: inventory kept
 * simple — Sellable, TT sample, eBay sample, Random pulls — one starting
 * count, and the sales report subtracting).
 *
 *   - the sheet's numbers are what each model holds, exactly
 *   - a model with stock before and not on the sheet is zero; damaged and
 *     sold-waiting-to-ship are emptied
 *   - a watch not in the catalogue is added from the sheet
 *   - old sales never move the new numbers: not one sold before the start day
 *   - sales from the start day on come off the new numbers, once
 *   - the same sheet uploaded twice: the same numbers, nothing taken off twice
 *   - the older count sheet (Sample TikTok / Sample eBay / Damaged) is read too
 *   - a sheet with a bad number saves nothing; one with no numbers saves nothing
 *   - a model on two rows is added together
 *
 * Inventory on the development database starts again from this script's
 * sheet; the start date is put back at the end, and its fixtures removed.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-starting-count.mts
 */
import "dotenv/config";
import ExcelJS from "exceljs";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, fromDbDate, toDbDate, todayISO } from "../src/lib/domain/dates";
import { balancesFor } from "../src/lib/server/inventory";
import { bringStockUpToDate } from "../src/lib/server/deduction";
import { readStartingCount, saveStartingCount } from "../src/lib/server/starting-count";

assertDevDatabase("check-starting-count.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { inventoryStartDate: true, timezone: true } });
const today = todayISO(settings.timezone);
const START = addDays(today, -1);
const BEFORE = addDays(today, -3);
const M = { kept: "ZZSC-101", gone: "ZZSC-102", fresh: "ZZSC-103", sold: "ZZSC-104" };
const boss = await prisma.user.findFirstOrThrow({ where: { role: "BOSS", isActive: true }, select: { id: true } });

/** An .xlsx count sheet with these headings and rows. */
async function sheet(headings: string[], rows: (string | number | null)[][]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Count");
  ws.getCell("A1").value = "Starting count";
  ws.getRow(2).values = headings;
  for (const r of rows) ws.addRow(r);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
const NEW = ["Model", "Description", "Sellable", "TT sample", "eBay sample", "Random pulls"];

async function stockOf(model: string) {
  const p = await prisma.product.findUnique({ where: { model }, select: { id: true } });
  if (!p) return null;
  const b = (await balancesFor(prisma, [p.id])).get(p.id);
  return b ?? { SELLABLE: 0, SAMPLE_EBAY: 0, SAMPLE_TIKTOK: 0, RANDOM_PULLS: 0, DAMAGED: 0, WAITING: 0 };
}

/** A day's TikTok report with these models sold. */
async function sales(day: string, models: string[], tag: string) {
  const batch = await prisma.importBatch.create({
    data: { business: "WATCH", platform: "TIKTOK", slot: "DAY", showDate: toDbDate(day), status: "OK", files: [], flags: [] },
    select: { id: true },
  });
  for (const [i, model] of models.entries()) {
    await prisma.salesRecord.create({
      data: {
        batchId: batch.id, business: "WATCH", platform: "TIKTOK", show: "TikTok AM", showDate: toDbDate(day),
        shiftTag: "", rawShiftTag: "", orderRef: `ZZSC-${tag}-${i}`, lineRef: `${i}`, buyer: "zz", stockNumber: model,
        tracking: "", sourceFile: "zz-starting-count.csv",
      },
    });
  }
}

/** Products this run made outside the ZZSC- names, removed at the end. */
const made: string[] = [];

async function clean() {
  const zz = await prisma.product.findMany({ where: { OR: [{ model: { startsWith: "ZZSC-" } }, { model: { in: made } }] }, select: { id: true } });
  const ids = zz.map((p) => p.id);
  await prisma.stockMove.deleteMany({ where: { productId: { in: ids } } });
  await prisma.stockSale.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
  await prisma.importBatch.deleteMany({ where: { sales: { some: { sourceFile: "zz-starting-count.csv" } } } });
}

async function start(buffer: ArrayBuffer, day = START) {
  const read = await readStartingCount(buffer);
  if (read.problems.length > 0) return { read, saved: null };
  const saved = await saveStartingCount(boss.id, read.entries, day, "check");
  await bringStockUpToDate(boss.id);
  return { read, saved };
}

await clean();
try {
  /* ---------------------------------------------------------- before */
  // Old stock: kept had 5 sellable and a damaged one; gone had 4; sold had 2.
  for (const [model, place, qty] of [
    [M.kept, "SELLABLE", 5], [M.kept, "DAMAGED", 1], [M.gone, "SELLABLE", 4], [M.sold, "SELLABLE", 2],
  ] as const) {
    const p = await prisma.product.upsert({ where: { model }, create: { model, active: true }, update: {}, select: { id: true } });
    await prisma.stockMove.create({ data: { productId: p.id, place, qty, kind: "COUNT", entryId: "zz-old" } });
  }
  // A sale from before the start day, and one on it.
  await sales(BEFORE, [M.sold], "before");
  await sales(START, [M.sold], "on");

  /* ------------------------------------------------- bad sheets save nothing */
  const bad = await start(await sheet(NEW, [[M.kept, "", "three", 1, 0, 0]]));
  check("a bad number: nothing saved, the row named", [bad.saved, bad.read.problems.some((p) => p.includes("row 3"))], [null, true]);
  check("…and the old numbers are still there", (await stockOf(M.kept))?.SELLABLE, 5);
  const renamed = await start(await sheet(["Model", "Sellable", "TT", "eBay sample", "Random pulls"], [[M.kept, 1, 1, 1, 1]]));
  check("a renamed column: nothing saved, the column named", renamed.read.problems.some((p) => p.includes('"TT sample"')), true);

  /* --------------------------------------------------- the starting count */
  const first = await start(
    await sheet(NEW, [
      [M.kept, "kept watch", 3, 1, null, null],
      [M.fresh, "a watch not on the list", 2, null, null, 1],
      [M.sold, "", 4, null, null, null],
      [M.kept, "", 1, null, null, null], // a second spot of kept
    ]),
  );
  check("saved", first.saved?.ok, true);
  check("a model on two rows is added together", (await stockOf(M.kept))?.SELLABLE, 4);
  check("exactly what the sheet says, damaged emptied", await stockOf(M.kept), {
    SELLABLE: 4, SAMPLE_EBAY: 0, SAMPLE_TIKTOK: 1, RANDOM_PULLS: 0, DAMAGED: 0, WAITING: 0,
  });
  check("not on the sheet: zero everywhere", await stockOf(M.gone), {
    SELLABLE: 0, SAMPLE_EBAY: 0, SAMPLE_TIKTOK: 0, RANDOM_PULLS: 0, DAMAGED: 0, WAITING: 0,
  });
  check("a watch not in the catalogue is added from the sheet", (await stockOf(M.fresh))?.RANDOM_PULLS, 1);
  check("the start day is set", fromDbDate((await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })).inventoryStartDate!), START);
  const sold = await stockOf(M.sold);
  check("the sale on the start day came off the new 4; the one before did not", [sold?.SELLABLE, sold?.WAITING], [3, 1]);

  /* --------------------------------------------------------- uploaded again */
  await start(
    await sheet(NEW, [
      [M.kept, "kept watch", 3, 1, null, null],
      [M.fresh, "a watch not on the list", 2, null, null, 1],
      [M.sold, "", 4, null, null, null],
      [M.kept, "", 1, null, null, null],
    ]),
  );
  const again = await stockOf(M.sold);
  check("the same sheet again: the same numbers, the sale taken off once", [again?.SELLABLE, again?.WAITING], [3, 1]);

  /* ------------------------------------- two at once (review, 10/14) */
  /*
    A stock update that read the old start day, then waited on the stock lock
    while the starting count was saved, used to take the old day's sales off
    the new count: every watch shipped since, subtracted twice. Held here:
    the old start day is in place, an update starts and waits on the lock,
    the new start day is saved under it, and the update must use the new one.
  */
  const beforeRace = (await stockOf(M.sold))?.SELLABLE;
  await prisma.settings.update({ where: { id: "singleton" }, data: { inventoryStartDate: toDbDate(addDays(today, -6)) } });
  let racing: Promise<unknown> | null = null;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;
      racing = bringStockUpToDate(boss.id);
      await new Promise((r) => setTimeout(r, 1500));
      await tx.settings.update({ where: { id: "singleton" }, data: { inventoryStartDate: toDbDate(START) } });
    },
    { timeout: 30_000 },
  );
  await racing;
  check("an update waiting on the count uses the new start day: no old sale taken off again", (await stockOf(M.sold))?.SELLABLE, beforeRace);

  /* -------------------------------------------------- the older count sheet */
  const old = await start(
    await sheet(["Model", "Description", "Collection", "Sellable", "Sample eBay", "Sample TikTok", "Random pulls", "Damaged", "Notes"], [
      [M.kept, "", "", 2, 1, 0, 0, 3, ""],
    ]),
  );
  check("the older sheet is read; Damaged is not", [old.saved?.ok, (await stockOf(M.kept))?.SAMPLE_EBAY, (await stockOf(M.kept))?.DAMAGED], [true, 1, 0]);
  check("and it says Damaged was not read", old.read.notes.some((n) => n.includes("Damaged")), true);

  /* ----------------------------------- a leading zero Excel took away */
  const had0071 = await prisma.product.findUnique({ where: { model: "0071" }, select: { id: true } });
  if (!had0071) made.push("0071");
  await prisma.product.upsert({ where: { model: "0071" }, create: { model: "0071", active: true }, update: {}, select: { id: true } });
  const zeros = await start(await sheet(NEW, [[M.kept, "", 1, null, null, null], ["71", "", 2, null, null, null]]));
  check("a 71 on the sheet is the catalogue's 0071, not a new watch", [zeros.saved?.added, (await stockOf("0071"))?.SELLABLE, await stockOf("71")], [[], 2, null]);

  /* ------------------------------------------- a new model that cannot be one */
  const typo = await start(await sheet(NEW, [[M.kept, "", 1, null, null, null], ["ZZSC 105", "", 1, null, null, null]]));
  check("a new model number with a space: nothing saved, the row named", [typo.saved?.ok, typo.saved?.problems.some((p) => p.includes("space"))], [false, true]);

  /* --------------------------------------- an extra tab the counter added */
  const extraTab = new ExcelJS.Workbook();
  const counts = extraTab.addWorksheet("Count");
  counts.getRow(1).values = NEW;
  counts.addRow([M.kept, "", 2, null, null, null]);
  const notesTab = extraTab.addWorksheet("Notes");
  notesTab.getRow(1).values = ["Model", "Where it was"];
  notesTab.addRow([M.kept, "back shelf"]);
  const withNotes = await readStartingCount((await extraTab.xlsx.writeBuffer()) as ArrayBuffer);
  check("an extra tab with none of the count columns is left alone", [withNotes.problems, withNotes.entries.length], [[], 1]);

  /* --------------------------------------------------- a sheet of nothing */
  const empty = await readStartingCount(await sheet(NEW, [[M.kept, "", null, null, null, null]]));
  check("a sheet with no numbers is not a count", empty.entries.length, 0);
} finally {
  await clean();
  await prisma.settings.update({ where: { id: "singleton" }, data: { inventoryStartDate: settings.inventoryStartDate } });
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

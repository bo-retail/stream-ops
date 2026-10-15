/**
 * Returns, against a real database (Samuel, 10/15: a place to add returns back
 * to inventory, kept simple — a Model / Quantity sheet, all back to Sellable).
 *
 * Each what-if below is run, with what should happen:
 *   - the ordinary day: two models come back; Sellable goes up by exactly that
 *   - the same sheet uploaded twice that day: asked about, nothing added twice;
 *     ticked "add it anyway": added
 *   - a corrected sheet uploaded without undoing the first: asked about
 *   - the same sheet again with the day corrected, without undoing: asked about
 *   - the same one watch back again on another day: ordinary, added
 *   - two people upload the same sheet at once: only one goes in
 *   - came back on a day the models were since counted: asked about
 *   - a mistyped model: refused, and nothing else on the sheet goes in either
 *   - Excel dropped the leading zeros: the catalogue's model gets it
 *   - a blank, a zero, a word for a quantity; a model on two rows
 *   - a big number (a delivery on the wrong page): asked about
 *   - the Inventory download uploaded here: refused
 *   - the downloaded returns sheet, filled in, is read back
 *   - undo: off Sellable again, marked Undone, not undone twice, and the
 *     corrected sheet goes in after without being called a repeat
 *   - undo after it sold: below zero, and said; undo after a count, or after
 *     a starting count that wrote no line for the model: refused
 *   - older Movements-page returns stay out of this log
 *   - the Excel download lists the returns
 *
 * Days are set two and three days ahead, past any count the development
 * database had today.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-returns.mts
 */
import "dotenv/config";
import ExcelJS from "exceljs";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, todayISO } from "../src/lib/domain/dates";
import { balancesFor } from "../src/lib/server/inventory";
import { inventoryWorkbook, rangeOf } from "../src/lib/server/inventory-export";
import { readReceivingSheet } from "../src/lib/server/receive";
import { returnLog, returnsSheet, saveReturn, undoReturn } from "../src/lib/server/returns";

assertDevDatabase("check-returns.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { timezone: true } });
const today = todayISO(settings.timezone);
const D1 = addDays(today, 2);
const D2 = addDays(today, 3);
const boss = await prisma.user.findFirstOrThrow({ where: { role: "BOSS", isActive: true }, select: { id: true } });
const A = "ZZRT-201";
const B = "ZZRT-202";
const ZEROS = "0099771"; // Excel turns it into 99771
const MODELS = [A, B, ZEROS, "ZZRT-203"];
const FIXTURE = "zz-check-returns";

async function clean() {
  const ids = (await prisma.product.findMany({ where: { model: { in: MODELS } }, select: { id: true } })).map((p) => p.id);
  const entries = (await prisma.stockMove.findMany({ where: { productId: { in: ids } }, select: { entryId: true } })).map((m) => m.entryId);
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...entries, FIXTURE] } } });
  await prisma.stockMove.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
}

async function sheet(rows: (string | number | null)[][], headings = ["Model", "Quantity"]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Returned");
  ws.getCell("A1").value = "Returns";
  ws.getRow(2).values = headings;
  for (const r of rows) ws.addRow(r);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
const read = async (rows: (string | number | null)[][]) => readReceivingSheet(await sheet(rows), "returns sheet");
const back = async (rows: (string | number | null)[][], on: string, file: string, confirmed = false) =>
  saveReturn(boss.id, (await read(rows)).entries, on, file, confirmed);
async function sellable(model: string) {
  const p = await prisma.product.findUniqueOrThrow({ where: { model }, select: { id: true } });
  return (await balancesFor(prisma, [p.id])).get(p.id)?.SELLABLE ?? 0;
}
const entryOf = async (file: string) => (await returnLog()).find((r) => r.name === file && !r.undone)!.entryId;

await clean();
try {
  for (const model of MODELS.slice(0, 3)) {
    const p = await prisma.product.create({ data: { model, description: "check-returns", active: true }, select: { id: true } });
    await prisma.stockMove.create({ data: { productId: p.id, place: "SELLABLE", qty: 5, kind: "COUNT", countedQty: 5, entryId: FIXTURE, at: new Date(Date.now() - 3_600_000) } });
  }
  const p = await prisma.product.findUniqueOrThrow({ where: { model: A }, select: { id: true } });

  /* -------------------------------------------------------- the ordinary day */
  const day = await back([[A, 2], [B, 1]], D1, "ordinary.xlsx");
  check("two models back: added", [day.ok, day.pieces, day.models], [true, 3, 2]);
  check("…all to Sellable, exactly", [await sellable(A), await sellable(B)], [7, 6]);
  const b = (await balancesFor(prisma, [p.id])).get(p.id)!;
  check("…nothing in the samples or random pulls", [b.SAMPLE_TIKTOK, b.SAMPLE_EBAY, b.RANDOM_PULLS], [0, 0, 0]);
  const logged = (await returnLog()).find((r) => r.name === "ordinary.xlsx");
  check("…in the log, by model", [logged?.pieces, logged?.items, logged?.returnedOn], [3, [{ model: A, qty: 2 }, { model: B, qty: 1 }], D1]);

  /* ---------------------------------------------------- uploaded twice, etc. */
  const twice = await back([[B, 1], [A, 2]], D1, "ordinary (1).xlsx");
  check("the same sheet again that day (rows in another order, another file name): asked, nothing added", [twice.ok, twice.problems[0]?.includes("already added"), await sellable(A)], [false, true, 7]);
  const fixed = await back([[A, 3], [B, 1]], D1, "ordinary fixed.xlsx");
  check("a corrected sheet without undoing the first: asked, nothing added", [fixed.ok, fixed.problems[0]?.includes("undo it below first"), await sellable(A)], [false, true, 7]);
  const redated = await back([[A, 2], [B, 1]], D2, "ordinary.xlsx");
  check("the same sheet with the day corrected, without undoing: asked, nothing added", [redated.ok, redated.problems[0]?.includes("under another day"), await sellable(A)], [false, true, 7]);
  const really = await back([[A, 2], [B, 1]], D1, "really-another.xlsx", true);
  check("…ticked \"add it anyway\": added", [really.ok, await sellable(A)], [true, 9]);
  const nextDay = await back([[B, 1]], D2, "next-day.xlsx");
  check("one watch of a model back again on another day: ordinary, added", [nextDay.ok, await sellable(B)], [true, 8]);

  const [r1, r2] = await Promise.all([back([[A, 1]], D2, "at-once-1.xlsx"), back([[A, 1]], D2, "at-once-2.xlsx")]);
  check("two people upload the same sheet at once: only one goes in", [[r1.ok, r2.ok].filter(Boolean).length, await sellable(A)], [1, 10]);

  /* ------------------------------------------------- since counted */
  await prisma.stockMove.create({ data: { productId: p.id, place: "SELLABLE", qty: 0, kind: "COUNT", countedQty: 10, entryId: FIXTURE } });
  const onCountDay = await back([[A, 1], [ZEROS, 1]], today, "counted-day.xlsx");
  check("came back on the day they were since counted: asked, nothing added", [onCountDay.ok, onCountDay.problems[0]?.includes("counted on"), await sellable(A)], [false, true, 10]);
  const twoAsks = await back([[A, 30]], today, "two-asks.xlsx");
  check("two questions at once (counted since, and a large number): both shown, so one tick answers both", [twoAsks.ok, twoAsks.problems.some((x) => x.includes("counted on")), twoAsks.problems.some((x) => x.includes("Large quantities"))], [false, true, true]);
  check("…a later day is ordinary", (await back([[A, 1], [B, 1]], addDays(today, 4), "after-count.xlsx")).ok, true);

  /* ------------------------------------------------------- bad or odd values */
  const typo = await back([[A, 1], ["ZZRT-2O1", 1]], addDays(today, 5), "typo.xlsx");
  check("a mistyped model: refused, named, and nothing else on the sheet goes in", [typo.ok, typo.problems[0]?.includes("ZZRT-2O1"), await sellable(A)], [false, true, 11]);
  check("…and no model is made from it", await prisma.product.count({ where: { model: "ZZRT-2O1" } }), 0);
  const zeros = await back([[99771, 1]], D1, "zeros.xlsx");
  check("Excel dropped the leading zeros: the catalogue's model gets it", [zeros.ok, await sellable(ZEROS)], [true, 6]);
  check("a sheet of blanks and zeros adds nothing", [(await read([[A, null], [B, 0]])).entries.length], [0]);
  const word = await read([[A, "two"]]);
  check("a word for a quantity: named, nothing added", word.problems.some((x) => x.includes("Quantity")), true);
  const twoRows = await read([[B, 1], [B, 2]]);
  check("one model on two rows: added together, and said", [twoRows.entries[0]?.qty, twoRows.notes.length], [3, 1]);
  const big = await back([[B, 40]], addDays(today, 5), "big.xlsx");
  check("40 of one model (a delivery on the wrong page): asked about, nothing added", [big.ok, big.problems[0]?.includes("Receive inventory"), await sellable(B)], [false, true, 9]);
  const download = await readReceivingSheet(await inventoryWorkbook(rangeOf(today, today), today, null, settings.timezone), "returns sheet");
  check("the Inventory download uploaded here: refused", [download.entries.length, download.problems[0]?.includes("not the returns sheet")], [0, true]);
  const notXlsx = await readReceivingSheet(new TextEncoder().encode("Model,Quantity\nA,1").buffer as ArrayBuffer, "returns sheet");
  check("a CSV instead of the sheet: refused", notXlsx.problems[0]?.includes("returns sheet"), true);

  // The downloaded sheet, filled in the way the shipping manager would.
  const blank = new ExcelJS.Workbook();
  await blank.xlsx.load(await returnsSheet(today));
  blank.getWorksheet("Returned")!.addRow([B, 1]);
  const filled = await readReceivingSheet((await blank.xlsx.writeBuffer()) as ArrayBuffer, "returns sheet");
  check("the downloaded returns sheet, filled in, is read", [filled.problems, filled.entries.map((e) => [e.model, e.qty])], [[], [[B, 1]]]);

  /* ---------------------------------------------------------------- undo */
  const D6 = addDays(today, 6);
  const wrong = await back([[B, 3]], D6, "wrong.xlsx");
  const wrongId = await entryOf("wrong.xlsx");
  const undone = await undoReturn(boss.id, wrongId);
  check("undo: off Sellable again", [wrong.ok, undone.ok, await sellable(B)], [true, true, 9]);
  check("…marked Undone in the log", (await returnLog()).find((r) => r.entryId === wrongId)?.undone, true);
  check("…undone twice: refused, nothing taken off again", [(await undoReturn(boss.id, wrongId)).ok, await sellable(B)], [false, 9]);
  const corrected = await back([[B, 4]], D6, "wrong-fixed.xlsx");
  check("…the corrected sheet after an undo is not asked about", [corrected.ok, await sellable(B)], [true, 13]);

  const sold = await back([[ZEROS, 4]], D6, "sold-since.xlsx");
  const zp = await prisma.product.findUniqueOrThrow({ where: { model: ZEROS }, select: { id: true } });
  await prisma.stockMove.create({ data: { productId: zp.id, place: "SELLABLE", qty: -9, kind: "ADJUST", reason: "zz sold", entryId: FIXTURE } });
  const afterSale = await undoReturn(boss.id, await entryOf("sold-since.xlsx"));
  check("undo after they sold: done, below zero, and said", [sold.ok, afterSale.ok, afterSale.message.includes("below zero"), await sellable(ZEROS)], [true, true, true, -3]);

  await back([[A, 2]], addDays(today, 7), "before-count.xlsx");
  await new Promise((r) => setTimeout(r, 20));
  await prisma.stockMove.create({ data: { productId: p.id, place: "SELLABLE", qty: 0, kind: "COUNT", countedQty: await sellable(A), entryId: FIXTURE } });
  const afterCount = await undoReturn(boss.id, await entryOf("before-count.xlsx"));
  check("undo after a count: refused, the count already has them", [afterCount.ok, afterCount.message.includes("counted")], [false, true]);

  await back([[B, 2]], addDays(today, 7), "before-start.xlsx");
  await new Promise((r) => setTimeout(r, 20));
  // A starting count whose number for B matched: no line for B, only its record.
  await prisma.auditLog.create({ data: { entityType: "StockMove", entityId: FIXTURE, action: "STARTING_COUNT", actorId: boss.id, summary: "check-returns" } });
  const afterStart = await undoReturn(boss.id, await entryOf("before-start.xlsx"));
  check("undo after a starting count that wrote no line for the model: refused", [afterStart.ok, await sellable(B)], [false, 15]);

  /* ----------------------------------------------- older returns, the download */
  await prisma.stockMove.create({ data: { productId: p.id, place: "SELLABLE", qty: 1, kind: "RETURN", reason: "Returned", note: "zz old movements return", entryId: `${FIXTURE}-old` } });
  check("an older Movements-page return is not in this log", (await returnLog()).some((r) => r.entryId === `${FIXTURE}-old`), false);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await inventoryWorkbook(rangeOf(today, addDays(today, 7)), today, null, settings.timezone));
  const rows: unknown[][] = [];
  wb.getWorksheet("Returned")!.eachRow((row, n) => { if (n > 2) rows.push((row.values as unknown[]).slice(1)); });
  // A: 2 + 2 + 1 (at once) + 1 (after count) + 2 (before count) = 8; refused and undone ones are left out.
  check("the Excel download lists the returns (undone ones left out)", rows.filter((r) => r[1] === A).reduce((n, r) => n + Number(r[2]), 0), 8);
} finally {
  await clean();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

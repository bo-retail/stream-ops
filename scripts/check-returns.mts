/**
 * Returns, against a real database (Samuel, 10/15: a place to add returns back
 * to inventory, kept simple — a Model / Quantity sheet, placed as a delivery is;
 * a model never in inventory where the page is told).
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
 *   - a model that has its samples: all to Sellable (the ordinary case below)
 *   - a model at zero with no samples (Samuel, 10/15: the shipment rules):
 *     1 or 2 back go to Random pulls; 3 or more fill both samples first
 *   - a model never in inventory (Gladys, 10/15): nothing added until the page
 *     says where it goes; then it goes there, the model is added and named; a
 *     place that is not one of the four is asked again; undone, the new model
 *     is switched off — but a model already on the list, never counted or sold,
 *     stays on (Receive's undo too); one asked about first is not created
 *   - one new number written two ways on one sheet: one model, not two
 *   - undo after a returned sample sold: the sample never goes below zero
 *   - the same sheet re-dated, for a model split across places: asked about
 *   - a number matching two catalogue models (leading zeros): refused, not a third
 *   - a new model answered in the box, then the upload asks, ticked: where it was told
 *   - a barcode, or a number with a space: refused, nothing else goes in
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
import { readReceivingSheet, saveReceipt, undoReceipt } from "../src/lib/server/receive";
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
const MODELS = [A, B, ZEROS, "ZZRT-203", "ZZRT-204", "ZZRT-205", "ZZRT-206", "ZZRT-207", "99882", "ZZRT-208", "0777123", "00777123", "777123"];
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
const back = async (rows: (string | number | null)[][], on: string, file: string, confirmed = false, placeFor: Record<string, string> = {}) =>
  saveReturn(boss.id, (await read(rows)).entries, on, file, confirmed, "", placeFor);
/** [Sellable, TT sample, eBay sample, Random pulls] */
async function stock(model: string) {
  const p = await prisma.product.findUniqueOrThrow({ where: { model }, select: { id: true } });
  const b = (await balancesFor(prisma, [p.id])).get(p.id);
  return [b?.SELLABLE ?? 0, b?.SAMPLE_TIKTOK ?? 0, b?.SAMPLE_EBAY ?? 0, b?.RANDOM_PULLS ?? 0];
}
const sellable = async (model: string) => (await stock(model))[0];
const activeOf = async (model: string) => (await prisma.product.findUnique({ where: { model }, select: { active: true } }))?.active;
const entryOf = async (file: string) => (await returnLog()).find((r) => r.name === file && !r.undone)!.entryId;

await clean();
try {
  for (const model of MODELS.slice(0, 3)) {
    const p = await prisma.product.create({ data: { model, description: "check-returns", active: true }, select: { id: true } });
    const at = new Date(Date.now() - 3_600_000);
    // 5 on the shelf and both samples out: a return of it goes all to Sellable.
    await prisma.stockMove.createMany({
      data: [
        { productId: p.id, place: "SELLABLE", qty: 5, kind: "COUNT", countedQty: 5, entryId: FIXTURE, at },
        { productId: p.id, place: "SAMPLE_TIKTOK", qty: 1, kind: "COUNT", countedQty: 1, entryId: FIXTURE, at },
        { productId: p.id, place: "SAMPLE_EBAY", qty: 1, kind: "COUNT", countedQty: 1, entryId: FIXTURE, at },
      ],
    });
  }
  const p = await prisma.product.findUniqueOrThrow({ where: { model: A }, select: { id: true } });

  /* -------------------------------------------------------- the ordinary day */
  const day = await back([[A, 2], [B, 1]], D1, "ordinary.xlsx");
  check("two models back: added", [day.ok, day.pieces, day.models], [true, 3, 2]);
  check("…all to Sellable, exactly", [await sellable(A), await sellable(B)], [7, 6]);
  const b = (await balancesFor(prisma, [p.id])).get(p.id)!;
  check("…a model with its samples: samples and random pulls untouched", [b.SAMPLE_TIKTOK, b.SAMPLE_EBAY, b.RANDOM_PULLS], [1, 1, 0]);
  const logged = (await returnLog()).find((r) => r.name === "ordinary.xlsx");
  check("…in the log, by model and place", [logged?.pieces, logged?.items.map((i) => [i.model, i.placed.SELLABLE, i.total]), logged?.returnedOn], [3, [[A, 2, 2], [B, 1, 1]], D1]);

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
  const D8 = addDays(today, 8);
  // On the list, at zero, never counted or sold: the shipment rules, and no samples yet.
  await prisma.product.create({ data: { model: "ZZRT-203", description: "check-returns: at zero", active: true } });
  const twoBack = await back([["ZZRT-203", 2]], D8, "at-zero.xlsx");
  check("a model at zero with no samples, 2 back: Random pulls, nothing new added", [twoBack.ok, twoBack.added, await stock("ZZRT-203")], [true, [], [0, 0, 0, 2]]);
  const undoZero = await undoReturn(boss.id, await entryOf("at-zero.xlsx"));
  check("…undone: off again, and the model (already on the list) stays on", [undoZero.ok, await stock("ZZRT-203"), await activeOf("ZZRT-203")], [true, [0, 0, 0, 0], true]);
  const fiveBack = await back([["ZZRT-203", 5]], addDays(today, 10), "five.xlsx");
  check("…5 back: TT sample 1, eBay sample 1, Sellable 3", [fiveBack.ok, await stock("ZZRT-203"), fiveBack.placed], [true, [3, 1, 1, 0], { SELLABLE: 3, SAMPLE_TIKTOK: 1, SAMPLE_EBAY: 1, RANDOM_PULLS: 0 }]);
  await prisma.stockMove.create({ data: { productId: (await prisma.product.findUniqueOrThrow({ where: { model: "ZZRT-203" } })).id, place: "SAMPLE_TIKTOK", qty: -1, kind: "ADJUST", reason: "zz sample sold", entryId: FIXTURE } });
  const undoFive = await undoReturn(boss.id, await entryOf("five.xlsx"));
  check("…its TT sample sold, then undone: the sample stays at 0, Sellable gives the piece", [undoFive.ok, await stock("ZZRT-203")], [true, [-1, 0, 0, 0]]);

  // Never in inventory.
  const fresh = await back([[A, 1], ["ZZRT-204", 3]], D8, "not-on-list.xlsx");
  check("a model never in inventory: asked where it goes, nothing added or created", [fresh.ok, fresh.needsPlace, await sellable(A), await prisma.product.count({ where: { model: "ZZRT-204" } })], [false, [{ model: "ZZRT-204", qty: 3 }], 11, 0]);
  const nonsense = await back([[A, 1], ["ZZRT-204", 3]], D8, "not-on-list.xlsx", false, { "ZZRT-204": "DAMAGED" });
  check("…a place that is not one of the four: asked again", [nonsense.ok, nonsense.needsPlace.length], [false, 1]);
  const placedNew = await back([[A, 1], ["ZZRT-204", 3]], D8, "not-on-list.xlsx", false, { "ZZRT-204": "SAMPLE_TIKTOK" });
  const made = await prisma.product.findUnique({ where: { model: "ZZRT-204" }, select: { active: true, needsDetails: true } });
  check("…told TT sample: all 3 there, the model added and named; the known one placed as usual", [placedNew.ok, placedNew.added, await stock("ZZRT-204"), await sellable(A), made], [true, ["ZZRT-204"], [0, 3, 0, 0], 12, { active: true, needsDetails: true }]);
  const undoFresh = await undoReturn(boss.id, await entryOf("not-on-list.xlsx"));
  check("…undone (a typo): its pieces off, the new model switched off, the known one stays on", [undoFresh.ok, await sellable(A), await stock("ZZRT-204"), await activeOf("ZZRT-204"), await activeOf(A)], [true, 11, [0, 0, 0, 0], false, true]);
  const askedNew = await back([["ZZRT-205", 30]], D8, "asked-new.xlsx", false, { "ZZRT-205": "SELLABLE" });
  check("a new model in an upload that is asked about first: not created", [askedNew.ok, await prisma.product.count({ where: { model: "ZZRT-205" } })], [false, 0]);
  const twoWays = await back([["99882", 1], ["099882", 1]], D8, "two-ways.xlsx");
  check("one new number written two ways: one model to place, not two", twoWays.needsPlace, [{ model: "99882", qty: 2 }]);
  const twoWaysIn = await back([["99882", 1], ["099882", 1]], D8, "two-ways.xlsx", false, { "99882": "SELLABLE" });
  check("…placed: one model, 2 pieces", [twoWaysIn.ok, await stock("99882"), await prisma.product.count({ where: { model: { in: ["99882", "099882"] } } })], [true, [2, 0, 0, 0], 1]);

  // Split across places (no samples yet: TT 1, eBay 1, Sellable 3), then the same sheet re-dated.
  await prisma.product.create({ data: { model: "ZZRT-208", description: "check-returns: split", active: true } });
  const split = await back([["ZZRT-208", 5]], addDays(today, 11), "split.xlsx");
  const splitAgain = await back([["ZZRT-208", 5]], addDays(today, 12), "split.xlsx");
  check("the same sheet re-dated, for a model split across places: asked, nothing added twice", [split.ok, splitAgain.ok, splitAgain.problems[0]?.includes("under another day"), await stock("ZZRT-208")], [true, false, true, [3, 1, 1, 0]]);

  // Two catalogue models that differ only in leading zeros.
  await prisma.product.createMany({ data: [{ model: "0777123", description: "check-returns", active: true }, { model: "00777123", description: "check-returns", active: true }] });
  const ambiguous = await back([[777123, 1]], addDays(today, 11), "ambiguous.xlsx");
  check("a number matching two catalogue models: refused, names both, no third made", [ambiguous.ok, ambiguous.needsPlace, ambiguous.problems[0]?.includes("0777123 or 00777123"), await prisma.product.count({ where: { model: "777123" } })], [false, [], true, 0]);

  // A new model, answered in the box; the upload then asks (ZZRT-208 already back that day), ticked.
  const askedAfterBox = await back([["ZZRT-208", 1], ["ZZRT-205", 2]], addDays(today, 11), "box-then-ask.xlsx", false, { "ZZRT-205": "SAMPLE_EBAY" });
  const tickedAfterBox = await back([["ZZRT-208", 1], ["ZZRT-205", 2]], addDays(today, 11), "box-then-ask.xlsx", true, { "ZZRT-205": "SAMPLE_EBAY" });
  check("a new model answered in the box, the upload asks, ticked: it goes where it was told", [askedAfterBox.ok, askedAfterBox.needsPlace, tickedAfterBox.ok, await stock("ZZRT-205")], [false, [], true, [0, 0, 2, 0]]);

  // Receive's undo had the same gap: a model already on the list, never counted or sold, is not switched off.
  await prisma.product.create({ data: { model: "ZZRT-206", description: "check-returns: on the list", active: true } });
  await saveReceipt(boss.id, [{ model: "ZZRT-206", qty: 4, where: "row 3", description: "" }, { model: "ZZRT-207", qty: 4, where: "row 4", description: "" }], D8, "zz-delivery.xlsx", true);
  const receiptId = (await prisma.stockMove.findFirstOrThrow({ where: { kind: "RECEIVED", note: { endsWith: "zz-delivery.xlsx" }, reason: { startsWith: "receipt " } } })).entryId;
  const undoDelivery = await undoReceipt(boss.id, receiptId);
  check("Receive undo: the model it created is switched off, the one already on the list stays on", [undoDelivery.ok, await activeOf("ZZRT-207"), await activeOf("ZZRT-206")], [true, false, true]);
  const barcode = await back([[A, 1], ["1234567890120", 1]], addDays(today, 9), "barcode.xlsx");
  check("a barcode in the Model column: refused, nothing else goes in", [barcode.ok, barcode.problems[0]?.includes("barcode"), await sellable(A)], [false, true, 11]);
  const spaced = await back([[A, 1], ["ZZRT 206", 1]], addDays(today, 9), "space.xlsx");
  check("a model number with a space: refused, nothing made", [spaced.ok, await prisma.product.count({ where: { model: "ZZRT 206" } }), await sellable(A)], [false, 0, 11]);
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
  check("the Excel download lists the returns (undone ones left out)", rows.filter((r) => r[1] === A).reduce((n, r) => n + Number(r[3]), 0), 8);
} finally {
  await clean();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

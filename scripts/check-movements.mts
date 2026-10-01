/**
 * Inventory step 4 — moving stock by hand — against a real database.
 *
 * The situations it will meet, run rather than reasoned about:
 *
 *   - a sample pulled: the total does not change
 *   - moving or taking away more than there is: refused, and nothing in the
 *     same save is kept
 *   - a giveaway, a damaged watch (to Damaged, still at cost), a found one
 *   - a model not in the catalogue: refused
 *   - an order cancelled while waiting to ship: back out of "waiting"; the same
 *     cancellation twice does nothing; the next upload does not take it off again
 *   - a return after shipping: back at the cost it left with; slightly damaged
 *     to random pulls
 *   - a return with no sale (sold before launch): back at the model's cost
 *   - an exchange (a watch out, no sale) and a refund only (nothing moves)
 *   - undo: everything reversed, the sale set back; undo twice refused
 *   - the prompts: a new model's samples, samples to random pulls at zero
 *   - the templates downloaded, filled in, uploaded; the wrong template refused
 *   - two people taking the last piece at once: one is refused
 *
 * Every model it makes starts ZZTEST-, every order ZZ-; all of it is removed at
 * the end. The cancelled-sale-and-upload step sets a start date and puts it
 * back; it is skipped if the development database has real sales.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-movements.mts
 */
import "dotenv/config";
import ExcelJS from "exceljs";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, toDbDate, todayISO } from "../src/lib/domain/dates";
import { readAdjustment, readMove, readReturn } from "../src/lib/domain/movements";
import type { Row } from "../src/lib/domain/movements";
import { bringStockUpToDate, getStartDate, setStartDate } from "../src/lib/server/deduction";
import { getModel, saveCount } from "../src/lib/server/inventory";
import { getPrompts, readTemplate, saveAdjustments, saveMoves, saveReturns, templateSheet, undoEntry } from "../src/lib/server/movements";
import { getSettings } from "../src/lib/server/settings";

assertDevDatabase("check-movements.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const P = "ZZTEST-";
const M1 = `${P}M100`, M2 = `${P}M200`, M3 = `${P}M300`;
const boss = await prisma.user.findFirst({ where: { role: "BOSS", isActive: true }, select: { id: true } });
if (!boss) {
  console.log("SKIP  needs an admin account. Run the seed first.");
  await prisma.$disconnect();
  process.exit(0);
}
const today = todayISO((await getSettings()).timezone);
const startBefore = await getStartDate();

async function cleanUp() {
  const products = (await prisma.product.findMany({ where: { model: { startsWith: P } }, select: { id: true } })).map((p) => p.id);
  const sales = (await prisma.stockSale.findMany({ where: { OR: [{ productId: { in: products } }, { orderRef: { startsWith: "ZZ-" } }] }, select: { id: true } })).map((s) => s.id);
  const entries = (await prisma.stockMove.findMany({ where: { productId: { in: products } }, select: { entryId: true } })).map((m) => m.entryId);
  await prisma.stockMove.deleteMany({ where: { OR: [{ productId: { in: products } }, { saleId: { in: sales } }] } });
  await prisma.stockSale.deleteMany({ where: { id: { in: sales } } });
  await prisma.stockEntry.deleteMany({ where: { id: { in: entries } } });
  await prisma.importBatch.deleteMany({ where: { files: { equals: [{ name: "ZZTEST" }] } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...products, ...entries] } } });
  await prisma.product.deleteMany({ where: { id: { in: products } } });
}
const stock = async (model: string) => {
  const b = (await getModel(model))!.balances;
  return { S: b.SELLABLE, E: b.SAMPLE_EBAY, T: b.SAMPLE_TIKTOK, R: b.RANDOM_PULLS, D: b.DAMAGED, W: b.WAITING };
};
const move = (row: Row) => {
  const r = readMove(row);
  if (!r.ok) throw new Error(r.why);
  return r.move;
};
const adj = (row: Row) => {
  const r = readAdjustment(row);
  if (!r.ok) throw new Error(r.why);
  return r.adjustment;
};
const ret = (row: Row) => {
  const r = readReturn(row);
  if (!r.ok) throw new Error(r.why);
  return r.ret;
};
/** A sold watch, as step 3 would have taken it off. */
async function sale(order: string, model: string, status: "SOLD" | "SENT", costCents: number) {
  const p = await prisma.product.findUniqueOrThrow({ where: { model } });
  const s = await prisma.stockSale.create({
    data: { key: `TIKTOK|ZZ-${order}|${model}|0`, platform: "TIKTOK", orderRef: `ZZ-${order}`, showDate: toDbDate(addDays(today, -1)), show: "TikTok PM", listing: model, productId: p.id, place: "SELLABLE", costCents, status },
  });
  await prisma.stockMove.createMany({ data: [
    { productId: p.id, place: "SELLABLE", qty: -1, kind: "SOLD", saleId: s.id, entryId: s.id },
    { productId: p.id, place: "WAITING", qty: 1, kind: "SOLD", saleId: s.id, entryId: s.id },
    ...(status === "SENT" ? [{ productId: p.id, place: "WAITING" as const, qty: -1, kind: "SENT" as const, saleId: s.id, entryId: s.id }] : []),
  ] });
  return s.id;
}

try {
  await cleanUp();
  await saveCount(boss.id, [
    { model: M1, counted: { SELLABLE: 5 }, allowNew: true },
    { model: M2, counted: { SELLABLE: 3 }, allowNew: true },
    { model: M3, counted: { SELLABLE: 0, SAMPLE_EBAY: 1, SAMPLE_TIKTOK: 1 }, allowNew: true },
  ], "check");
  await prisma.product.update({ where: { model: M1 }, data: { costCents: 2500 } });

  console.log("Moves.");
  const m1 = await saveMoves(boss.id, [move({ "Model #": M1, Quantity: 1, From: "Sellable", To: "eBay sample", Reason: "Sample pulled" })], "check");
  check("a sample pulled: off the shelf, onto the eBay table, the total the same", [m1.ok, await stock(M1)], [true, { S: 4, E: 1, T: 0, R: 0, D: 0, W: 0 }]);
  const tooMany = await saveMoves(boss.id, [
    move({ "Model #": M1, Quantity: 1, From: "Sellable", To: "TikTok sample", Reason: "Sample pulled" }),
    move({ "Model #": M1, Quantity: 9, From: "Sellable", To: "Random pulls", Reason: "Sample to random pulls" }),
  ], "check");
  check("moving more than there is: refused, and the good row in the same save is not kept", [tooMany.ok, (await stock(M1)).T], [false, 0]);
  check("a model not in the catalogue: refused", (await saveMoves(boss.id, [move({ "Model #": `${P}X999`, Quantity: 1, From: "Sellable", To: "Damaged", Reason: "Sample damaged" })], "check")).ok, false);

  console.log("\nAdjustments.");
  const a1 = await saveAdjustments(boss.id, [
    adj({ "Model #": M1, Action: "Subtract", Quantity: 1, Place: "Sellable", Reason: "Giveaway" }),
    adj({ "Model #": M1, Action: "Subtract", Quantity: 1, Place: "Sellable", Reason: "Damaged" }),
    adj({ "Model #": M1, Action: "Add", Quantity: 1, Place: "Random pulls", Reason: "Found" }),
  ], "check");
  check("a giveaway gone, a damaged one to Damaged, a found one in random pulls", [a1.ok, await stock(M1)], [true, { S: 2, E: 1, T: 0, R: 1, D: 1, W: 0 }]);
  const dmg = await prisma.stockMove.findFirstOrThrow({ where: { product: { model: M1 }, kind: "ADJUST", place: "DAMAGED" } });
  check("  the damaged one keeps its cost", dmg.unitCostCents, 2500);
  check("taking away more than there is: refused", (await saveAdjustments(boss.id, [adj({ "Model #": M1, Action: "Subtract", Quantity: 7, Place: "Sellable", Reason: "Lost" })], "check")).ok, false);

  console.log("\nReturns and cancellations.");
  const waiting = await sale("R1", M1, "SOLD", 2400);
  const shipped = await sale("R2", M1, "SENT", 2300);
  check("  (two sold: one waiting, one shipped)", await stock(M1), { S: 0, E: 1, T: 0, R: 1, D: 1, W: 1 });
  const c1 = await saveReturns(boss.id, [ret({ "Model #": M1, Quantity: 1, Type: "Back in stock", "Goes to": "Inventory", "Order #": "ZZ-R1" })], "check");
  check("cancelled before it shipped: out of waiting, back on the shelf, the sale marked cancelled", [c1.ok, await stock(M1), (await prisma.stockSale.findUniqueOrThrow({ where: { id: waiting } })).status], [true, { S: 1, E: 1, T: 0, R: 1, D: 1, W: 0 }, "CANCELLED"]);
  const again = await saveReturns(boss.id, [ret({ "Model #": M1, Quantity: 1, Type: "Back in stock", "Goes to": "Inventory", "Order #": "ZZ-R1" })], "check");
  check("the same cancellation twice: refused, nothing moves", [again.ok, again.problems[0]?.includes("already put back"), (await stock(M1)).S], [false, true, 1]);
  const r2 = await saveReturns(boss.id, [ret({ "Model #": M1, Quantity: 1, Type: "Back in stock", "Goes to": "Random pulls", "Order #": "ZZ-R2", "Condition / note": "scratched" })], "check");
  const back = await prisma.stockMove.findFirstOrThrow({ where: { saleId: shipped, kind: "RETURN" } });
  check("a return after shipping, slightly damaged: to random pulls, at the cost it left with", [r2.ok, (await stock(M1)).R, back.unitCostCents, (await prisma.stockSale.findUniqueOrThrow({ where: { id: shipped } })).status], [true, 2, 2300, "RETURNED"]);
  const before = await saveReturns(boss.id, [ret({ "Model #": M1, Quantity: 1, Type: "Back in stock", "Goes to": "Inventory", "Order #": "123456" })], "check");
  check("a return with no sale (sold before launch): back at the model's cost, and says so", [before.ok, (await stock(M1)).S, before.done[0]?.includes("before launch")], [true, 2, true]);
  const ex = await saveReturns(boss.id, [ret({ "Model #": M1, Quantity: 1, Type: "Exchange / reship" }), ret({ "Model #": M1, Quantity: 1, Type: "Refund only" })], "check");
  check("an exchange takes one off the shelf; a refund only moves nothing", [ex.ok, (await stock(M1)).S], [true, 1]);

  // The report still lists the cancelled order; the next upload must not take it off again.
  const realSales = await prisma.salesRecord.count({ where: { showDate: { gte: toDbDate(addDays(today, -15)) }, NOT: { orderRef: { startsWith: "ZZ-" } } } });
  if (realSales === 0) {
    await prisma.importBatch.create({
      data: {
        business: "WATCH", showDate: toDbDate(addDays(today, -1)), status: "OK", platform: "TIKTOK", slot: "NIGHT", files: [{ name: "ZZTEST" }], flags: [],
        sales: { create: [{ platform: "TIKTOK", show: "TikTok PM", showDate: toDbDate(addDays(today, -1)), shiftTag: "", rawShiftTag: "", orderRef: "ZZ-R1", lineRef: "1", buyer: "t", stockNumber: M1, tracking: "", sourceFile: "ZZTEST" }] },
      },
    });
    await setStartDate(boss.id, addDays(today, -1));
    await bringStockUpToDate(boss.id);
    check("the report still listing the cancelled order: not taken off again", [(await prisma.stockSale.findUniqueOrThrow({ where: { id: waiting } })).status, (await stock(M1)).W], ["CANCELLED", 0]);
    await setStartDate(boss.id, startBefore);
  } else console.log(`SKIP  the upload-after-cancellation step: ${realSales} real sale(s) in the dev database.`);

  console.log("\nUndo.");
  const entry = await prisma.stockEntry.findFirstOrThrow({ where: { kind: "RETURNS", summary: { contains: "cancelled before shipping" } } });
  const u = await undoEntry(boss.id, entry.id);
  check("undo a cancellation: back in waiting, the sale waiting again", [u.ok, (await stock(M1)).W, (await prisma.stockSale.findUniqueOrThrow({ where: { id: waiting } })).status], [true, 1, "SOLD"]);
  check("undo twice: refused", (await undoEntry(boss.id, entry.id)).ok, false);

  console.log("\nWhat Gladys is asked.");
  const p2 = await prisma.product.findUniqueOrThrow({ where: { model: M2 } });
  await prisma.stockMove.create({ data: { productId: p2.id, place: "SELLABLE", qty: 0, kind: "RECEIVED", note: "check: first arrival", entryId: "check-received" } });
  // A received line of 0 is not an arrival; one of 1 is.
  await prisma.stockMove.create({ data: { productId: p2.id, place: "SELLABLE", qty: 1, kind: "RECEIVED", note: "check: first arrival", entryId: "check-received" } });
  const asks = (await getPrompts()).filter((x) => x.model.startsWith(P));
  // M100's shelf is at 0 here (the undo above took its cancelled watch back to waiting) with its eBay sample out.
  check("a new model: pull its samples; a model out on the shelf: samples to random pulls", asks.map((x) => `${x.model}:${x.kind}`).sort(), [`${M1}:samples to random pulls`, `${M2}:pull samples`, `${M3}:samples to random pulls`].sort());
  for (const a of asks) await saveMoves(boss.id, a.moves.map((m) => ({ ...m, note: "" })), "prompt");
  check("said yes: samples on both tables; samples in random pulls; nothing more to ask", [
    await stock(M2), await stock(M3), (await getPrompts()).filter((x) => x.model.startsWith(P)).length,
  ], [{ S: 2, E: 1, T: 1, R: 0, D: 0, W: 0 }, { S: 0, E: 0, T: 0, R: 2, D: 0, W: 0 }, 0]);

  console.log("\nTemplates.");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await templateSheet("ADJUSTMENTS"));
  wb.worksheets[0].addRow([M2, "Subtract", 1, "Sellable", "Content", "for the reel"]);
  wb.worksheets[0].addRow([]);
  const filled = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const t = await readTemplate("ADJUSTMENTS", filled);
  const read = t.rows.flatMap(({ row }) => { const r = readAdjustment(row); return r.ok ? [r.adjustment] : []; });
  check("the adjustments template downloaded, filled in, read back", [t.problem, read.map((a) => [a.model, a.qty, a.reason])], [undefined, [[M2, -1, "Content"]]]);
  check("  and saved", [(await saveAdjustments(boss.id, read, "template")).ok, (await stock(M2)).S], [true, 1]);
  check("the adjustments template uploaded as moves: refused, says which it is", (await readTemplate("MOVES", filled)).problem?.includes("adjustments template"), true);

  console.log("\nTwo people at once.");
  const both = await Promise.all([
    saveMoves(boss.id, [move({ "Model #": M2, Quantity: 1, From: "Sellable", To: "Damaged", Reason: "Sample damaged" })], "a"),
    saveMoves(boss.id, [move({ "Model #": M2, Quantity: 1, From: "Sellable", To: "Random pulls", Reason: "Sample to random pulls" })], "b"),
  ]);
  check("both want the last piece on the shelf: one saved, one refused, never below zero", [both.map((b) => b.ok).sort(), (await stock(M2)).S], [[false, true], 0]);
} finally {
  console.log("\nCleaning up.");
  await cleanUp();
  await setStartDate(boss.id, startBefore);
  console.log(`Removed — ${await prisma.product.count({ where: { model: { startsWith: P } } })} test model(s) left.`);
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll movement checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

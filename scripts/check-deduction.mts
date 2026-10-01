/**
 * Inventory step 3 — paid orders come off stock — against a real database.
 *
 * The situations it will meet, run rather than reasoned about:
 *
 *   - nothing moves until a start date is set; sales before it never move
 *   - a paid line: off the shelf into "sold, waiting to ship"; an expensive
 *     model with nothing on the shelf: off its sample
 *   - a random pull named by Model #: off random pulls
 *   - a random pull with no Model #: waits, then is named by the packing scan
 *   - a model not in the catalogue: not taken off, listed
 *   - the same day uploaded again: nothing twice; run twice at once: nothing twice
 *   - a corrected report without a line: put back where it came from
 *   - a corrected Model # before packing: the wrong watch back, the right one off
 *   - its box closed: sent; the box reopened: back to waiting
 *   - a box closed short: only what was scanned is sent
 *   - a line removed from the report after it was sent: flagged, never reversed
 *   - the start date moved later: what was not sent is put back
 *   - diamond sales: never touched
 *   - two watches of one order whose line ids Excel rounded to the same number
 *   - one order in two uploads with different boxes: the latest upload decides
 *   - a box packed before its report with the wrong watch: listed, not taken off
 *   - switched off while boxes are packed, then on again: nothing shipped comes back
 *   - a sale older than two weeks whose box closes now: sent
 *   - a page opened with nothing changed: no run, no wait
 *
 * Every model it makes starts ZZTEST-, every order ZZ-, every box ZZT; all of
 * it is removed at the end and the start date put back as it was. It refuses
 * to run if the development database has real sales in the last two weeks,
 * because setting a start date would take those off too.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-deduction.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, toDbDate, todayISO } from "../src/lib/domain/dates";
import { bringStockUpToDate, getStartDate, setStartDate } from "../src/lib/server/deduction";
import { getModel, saveCount } from "../src/lib/server/inventory";
import { getSettings } from "../src/lib/server/settings";

assertDevDatabase("check-deduction.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const P = "ZZTEST-";
const PULLS = "#300 - Invicta Random Pulls";
const today = todayISO((await getSettings()).timezone);
const day = addDays(today, -1);

const boss = await prisma.user.findFirst({ where: { role: "BOSS", isActive: true }, select: { id: true } });
if (!boss) {
  console.log("SKIP  needs an admin account. Run the seed first.");
  await prisma.$disconnect();
  process.exit(0);
}
const realSales = await prisma.salesRecord.count({
  where: { showDate: { gte: toDbDate(addDays(today, -15)) }, NOT: { orderRef: { startsWith: "ZZ-" } } },
});
if (realSales > 0) {
  console.log(`SKIP  the development database has ${realSales} real sale(s) in the last two weeks; setting a start date would take them off too.`);
  await prisma.$disconnect();
  process.exit(0);
}
const startBefore = await getStartDate();

async function cleanUp() {
  const products = (await prisma.product.findMany({ where: { model: { startsWith: P } }, select: { id: true } })).map((p) => p.id);
  const sales = (await prisma.stockSale.findMany({ where: { OR: [{ productId: { in: products } }, { orderRef: { startsWith: "ZZ-" } }] }, select: { id: true } })).map((s) => s.id);
  await prisma.stockMove.deleteMany({ where: { OR: [{ productId: { in: products } }, { saleId: { in: sales } }] } });
  await prisma.stockSale.deleteMany({ where: { id: { in: sales } } });
  const boxes = (await prisma.package.findMany({ where: { trackingNumber: { startsWith: "ZZT" } }, select: { id: true } })).map((b) => b.id);
  await prisma.scanEvent.deleteMany({ where: { packageId: { in: boxes } } });
  await prisma.package.deleteMany({ where: { id: { in: boxes } } });
  await prisma.importBatch.deleteMany({ where: { files: { equals: [{ name: "ZZTEST" }] } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: products } } });
  await prisma.product.deleteMany({ where: { id: { in: products } } });
}

type Line = { order: string; stock: string; model?: string; qty?: number; tracking: string; lineRef?: string };
let uploads = 0;
/** A day's TikTok night report, uploaded (each call is a newer upload of the same file). */
async function upload(lines: Line[], business: "WATCH" | "DIAMOND" = "WATCH", date = day, slot: "DAY" | "NIGHT" = "NIGHT") {
  uploads++;
  await prisma.importBatch.create({
    data: {
      business, showDate: toDbDate(date), status: "OK", platform: "TIKTOK", slot,
      uploadedAt: new Date(Date.now() + uploads * 1000), files: [{ name: "ZZTEST" }], flags: [],
      sales: {
        create: lines.map((l) => ({
          business, platform: "TIKTOK", show: slot === "DAY" ? "TikTok AM" : "TikTok PM", showDate: toDbDate(date), shiftTag: "", rawShiftTag: "",
          orderRef: `ZZ-${l.order}`, lineRef: l.lineRef ?? "1", buyer: "test", stockNumber: l.stock, modelNumber: l.model ?? "", qty: l.qty ?? 1,
          tracking: l.tracking, sourceFile: "ZZTEST",
        })),
      },
    },
  });
}
async function box(tracking: string, status: "OPEN" | "CLOSED_COMPLETE" | "CLOSED_INCOMPLETE", items: Record<string, number>, pieces: [string, string][] = [], date = day) {
  const existing = await prisma.package.findUnique({ where: { trackingNumber: tracking } });
  const b = existing
    ? await prisma.package.update({ where: { id: existing.id }, data: { status } })
    : await prisma.package.create({ data: { trackingNumber: tracking, platform: "TIKTOK", showDate: toDbDate(date), status } });
  for (const [stockNumber, scanned] of Object.entries(items)) {
    await prisma.packageItem.upsert({
      where: { packageId_stockNumber: { packageId: b.id, stockNumber } },
      create: { packageId: b.id, stockNumber, expectedQty: scanned, scannedQty: scanned },
      update: { scannedQty: scanned },
    });
  }
  for (const [piece, listing] of pieces) {
    await prisma.scanEvent.create({ data: { packageId: b.id, userId: boss!.id, kind: "ITEM_PLACEHOLDER", stockNumber: piece, note: `Sold as: ${listing.toUpperCase()}` } });
  }
}
const stock = async (model: string) => {
  const b = (await getModel(model))!.balances;
  return { S: b.SELLABLE, R: b.RANDOM_PULLS, T: b.SAMPLE_TIKTOK, W: b.WAITING };
};

const D1 = `${P}D100`, D2 = `${P}D200`, D3 = `${P}D300`;
const LINES: Line[] = [
  { order: "1", stock: D1, qty: 2, tracking: "ZZT1" },
  { order: "2", stock: PULLS, model: D2, tracking: "ZZT2" },
  { order: "3", stock: PULLS, tracking: "ZZT3" },
  { order: "4", stock: D3, tracking: "ZZT4" },
  { order: "5", stock: `${P}X999`, tracking: "ZZT5" },
];

try {
  await cleanUp();
  await setStartDate(boss.id, null);
  await saveCount(boss.id, [
    { model: D1, counted: { SELLABLE: 5 }, allowNew: true },
    { model: D2, counted: { RANDOM_PULLS: 2, SELLABLE: 1 }, allowNew: true },
    { model: D3, counted: { SELLABLE: 0, SAMPLE_TIKTOK: 1 }, allowNew: true },
  ], "check");
  await upload(LINES);

  console.log("Before a start date.");
  const off = await bringStockUpToDate(boss.id);
  check("nothing moves: the switch is off", [off.on, await stock(D1)], [false, { S: 5, R: 0, T: 0, W: 0 }]);

  console.log("\nThe start date set: the day's sales come off.");
  await setStartDate(boss.id, day);
  const r1 = await bringStockUpToDate(boss.id);
  check("a listing of two: off the shelf, waiting to ship", await stock(D1), { S: 3, R: 0, T: 0, W: 2 });
  check("a random pull named by Model #: off random pulls", await stock(D2), { S: 1, R: 1, T: 0, W: 1 });
  check("nothing on the shelf: off the TikTok sample", await stock(D3), { S: 0, R: 0, T: 0, W: 1 });
  check("a random pull with no Model # waits; a model not in the catalogue is listed", [r1.unnamed.length, r1.unknown.map((u) => u.model)], [1, [`${P}X999`]]);
  const sale = await prisma.stockSale.findFirstOrThrow({ where: { orderRef: "ZZ-1" } });
  check("each sale keeps the cost it had", sale.costCents, (await prisma.product.findUniqueOrThrow({ where: { model: D1 } })).costCents);

  const again = await bringStockUpToDate(boss.id);
  check("run again: nothing changes", [again.sold, again.sent, again.putBack], [0, 0, 0]);
  await upload(LINES);
  await bringStockUpToDate(boss.id);
  check("the same day uploaded again: nothing comes off twice", await stock(D1), { S: 3, R: 0, T: 0, W: 2 });
  await Promise.all([bringStockUpToDate(boss.id), bringStockUpToDate(boss.id)]);
  check("two runs at once: nothing twice", [await stock(D1), await prisma.stockSale.count({ where: { orderRef: { startsWith: "ZZ-" } } })], [{ S: 3, R: 0, T: 0, W: 2 }, 4]);

  console.log("\nA corrected report.");
  await upload(LINES.filter((l) => l.order !== "4"));
  const r2 = await bringStockUpToDate(boss.id);
  check("a line no longer in the report: put back on the sample it came from", [r2.putBack, await stock(D3)], [1, { S: 0, R: 0, T: 1, W: 0 }]);
  await upload(LINES.filter((l) => l.order !== "4").map((l) => (l.order === "2" ? { ...l, model: D1 } : l)));
  await bringStockUpToDate(boss.id);
  check("a corrected Model #: the wrong watch back to random pulls, the right one off", [await stock(D2), await stock(D1)], [{ S: 1, R: 2, T: 0, W: 0 }, { S: 2, R: 0, T: 0, W: 3 }]);
  // Back to the first Model #, as the packing below expects.
  await upload(LINES.filter((l) => l.order !== "4"));
  await bringStockUpToDate(boss.id);

  console.log("\nPacking.");
  await box("ZZT1", "CLOSED_COMPLETE", { [D1]: 2 });
  const r3 = await bringStockUpToDate(boss.id);
  check("its box closed: both sent, gone from stock", [r3.sent, await stock(D1)], [2, { S: 3, R: 0, T: 0, W: 0 }]);
  await box("ZZT1", "OPEN", {});
  await bringStockUpToDate(boss.id);
  check("the box reopened: back to waiting", await stock(D1), { S: 3, R: 0, T: 0, W: 2 });
  await box("ZZT1", "CLOSED_INCOMPLETE", { [D1]: 1 });
  await bringStockUpToDate(boss.id);
  check("closed short with one scanned: one sent, one still waiting", await stock(D1), { S: 3, R: 0, T: 0, W: 1 });
  await box("ZZT1", "CLOSED_COMPLETE", { [D1]: 2 });
  await bringStockUpToDate(boss.id);

  await box("ZZT3", "CLOSED_COMPLETE", {}, [[D2, PULLS]]);
  const r4 = await bringStockUpToDate(boss.id);
  check("the unnamed random pull, its piece scanned: off random pulls and sent", [r4.unnamed.length, await stock(D2)], [0, { S: 1, R: 0, T: 0, W: 1 }]);

  console.log("\nAfter it was sent.");
  await upload(LINES.filter((l) => l.order !== "4" && l.order !== "1"));
  await bringStockUpToDate(boss.id);
  const flagged = await prisma.stockSale.findMany({ where: { orderRef: "ZZ-1" }, select: { status: true, flag: true } });
  check("removed from the report after it was sent: still sent, flagged for a person", [flagged.map((f) => f.status), flagged.every((f) => f.flag.startsWith("Sent, but no longer")), await stock(D1)], [["SENT", "SENT"], true, { S: 3, R: 0, T: 0, W: 0 }]);

  console.log("\nThe start date moved later.");
  await setStartDate(boss.id, today);
  await bringStockUpToDate(boss.id);
  check("what was not sent is put back (order 2, still waiting)", await stock(D2), { S: 1, R: 1, T: 0, W: 0 });
  check("what was sent stays sent, and is not flagged as missing from the reports", (await prisma.stockSale.findMany({ where: { orderRef: "ZZ-3" }, select: { status: true, flag: true } })).map((s) => [s.status, s.flag]), [["SENT", ""]]);
  await bringStockUpToDate(boss.id);
  check("  …nor on the next run", (await prisma.stockSale.findFirstOrThrow({ where: { orderRef: "ZZ-3" } })).flag, "");
  await setStartDate(boss.id, day);

  console.log("\nDiamonds.");
  await upload([{ order: "D1", stock: D1, tracking: "ZZT9" }], "DIAMOND");
  await bringStockUpToDate(boss.id);
  check("a diamond sale never touches watch stock", await prisma.stockSale.count({ where: { orderRef: "ZZ-D1" } }), 0);

  console.log("\nExcel-damaged line ids, and an order in two uploads.");
  // Two watches of one order whose eBay-style line ids Excel rounded to the same number.
  await upload([...LINES.filter((l) => l.order !== "4"), { order: "6", stock: D1, tracking: "ZZT6", lineRef: "1.00839E+13" }, { order: "6", stock: D3, tracking: "ZZT6", lineRef: "1.00839E+13" }]);
  await saveCount(boss.id, [{ model: D3, counted: { SELLABLE: 1, SAMPLE_TIKTOK: 1 } }], "check");
  await bringStockUpToDate(boss.id);
  check("two watches sharing a rounded line id: both come off", (await prisma.stockSale.findMany({ where: { orderRef: "ZZ-6", status: "SOLD" }, select: { product: { select: { model: true } } } })).map((s) => s.product.model).sort(), [D1, D3].sort());
  // Order 7 in the morning file without a box, and in the night file (uploaded later) with its box, closed.
  await upload([{ order: "7", stock: D3, tracking: "" }], "WATCH", day, "DAY");
  await upload([...LINES.filter((l) => l.order !== "4"), { order: "6", stock: D1, tracking: "ZZT6", lineRef: "1.00839E+13" }, { order: "6", stock: D3, tracking: "ZZT6", lineRef: "1.00839E+13" }, { order: "7", stock: D3, tracking: "ZZT7" }]);
  await box("ZZT7", "CLOSED_COMPLETE", { [D3]: 1 });
  const runs = [await bringStockUpToDate(boss.id), await bringStockUpToDate(boss.id), await bringStockUpToDate(boss.id)];
  check("an order in two uploads: one watch, read from the latest, sent — and it stays so run after run", [
    await prisma.stockSale.count({ where: { orderRef: "ZZ-7" } }),
    (await prisma.stockSale.findFirstOrThrow({ where: { orderRef: "ZZ-7" } })).status,
    runs.map((r) => r.sent + r.unsent),
  ], [1, "SENT", [1, 0, 0]]);

  console.log("\nA box packed before its report.");
  await upload([...LINES.filter((l) => l.order !== "4"), { order: "6", stock: D1, tracking: "ZZT6", lineRef: "1.00839E+13" }, { order: "6", stock: D3, tracking: "ZZT6", lineRef: "1.00839E+13" }, { order: "7", stock: D3, tracking: "ZZT7" }, { order: "8", stock: D1, tracking: "ZZT8" }]);
  await box("ZZT8", "CLOSED_COMPLETE", { [D2]: 1 });
  const r8 = await bringStockUpToDate(boss.id);
  check("the wrong watch scanned: the sold one is not taken off as sent, the scanned one is listed", [
    (await prisma.stockSale.findFirstOrThrow({ where: { orderRef: "ZZ-8" } })).status,
    r8.strays.filter((s) => s.tracking === "ZZT8").map((s) => s.model),
  ], ["SOLD", [D2]]);

  console.log("\nSwitched off, then on again.");
  await setStartDate(boss.id, null);
  await box("ZZT6", "CLOSED_COMPLETE", { [D1]: 1, [D3]: 1 });
  await bringStockUpToDate(boss.id);
  check("switched off: a box packed meanwhile still sends its watches", (await prisma.stockSale.findMany({ where: { orderRef: "ZZ-6" }, select: { status: true } })).map((s) => s.status), ["SENT", "SENT"]);
  await setStartDate(boss.id, today);
  await bringStockUpToDate(boss.id);
  check("on again with a later date: what shipped meanwhile stays shipped, not back on the shelf", (await prisma.stockSale.findMany({ where: { orderRef: "ZZ-6" }, select: { status: true } })).map((s) => s.status), ["SENT", "SENT"]);
  await setStartDate(boss.id, day);

  console.log("\nA sale older than two weeks.");
  const old = addDays(today, -16);
  await setStartDate(boss.id, addDays(today, -20));
  await upload([{ order: "9", stock: D1, tracking: "ZZT9OLD" }], "WATCH", old);
  // Taken off back when it was recent (the run of that day), still waiting now.
  const p1 = await prisma.product.findUniqueOrThrow({ where: { model: D1 } });
  const oldSale = await prisma.stockSale.create({
    data: { key: `TIKTOK|ZZ-9|${D1}|0`, platform: "TIKTOK", orderRef: "ZZ-9", showDate: toDbDate(old), show: "TikTok PM", tracking: "ZZT9OLD", listing: D1, productId: p1.id, place: "SELLABLE", costCents: p1.costCents },
  });
  await prisma.stockMove.createMany({ data: [
    { productId: p1.id, place: "SELLABLE", qty: -1, kind: "SOLD", saleId: oldSale.id, entryId: oldSale.id },
    { productId: p1.id, place: "WAITING", qty: 1, kind: "SOLD", saleId: oldSale.id, entryId: oldSale.id },
  ] });
  await box("ZZT9OLD", "CLOSED_COMPLETE", { [D1]: 1 }, [], old);
  await bringStockUpToDate(boss.id);
  check("its box closes now: it is sent, not stuck waiting", (await prisma.stockSale.findUniqueOrThrow({ where: { id: oldSale.id } })).status, "SENT");
  await setStartDate(boss.id, day);

  console.log("\nA page opened with nothing changed.");
  await bringStockUpToDate(boss.id);
  const skip = await bringStockUpToDate(boss.id, { ifChanged: true });
  check("no run: nothing has changed since the last one", skip.skipped, true);
  await upload([{ order: "10", stock: D1, tracking: "ZZT10" }], "WATCH", day, "DAY");
  const ran = await bringStockUpToDate(boss.id, { ifChanged: true });
  check("after a new upload it runs again", [ran.skipped, ran.sold], [false, 1]);

  console.log("\nHistory.");
  let blocked = false;
  try {
    await prisma.stockSale.delete({ where: { id: sale.id } });
  } catch {
    blocked = true;
  }
  check("a sold watch with stock lines cannot be deleted", blocked, true);
} finally {
  console.log("\nCleaning up.");
  await cleanUp();
  await setStartDate(boss.id, startBefore);
  console.log(`Removed — ${await prisma.product.count({ where: { model: { startsWith: P } } })} test model(s) left; start date back to ${startBefore ?? "off"}.`);
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll deduction checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

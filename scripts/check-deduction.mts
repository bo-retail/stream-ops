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

type Line = { order: string; stock: string; model?: string; qty?: number; tracking: string; business?: "WATCH" | "DIAMOND" };
let uploads = 0;
/** A day's TikTok night report, uploaded (each call is a newer upload of the same file). */
async function upload(lines: Line[], business: "WATCH" | "DIAMOND" = "WATCH") {
  uploads++;
  await prisma.importBatch.create({
    data: {
      business, showDate: toDbDate(day), status: "OK", platform: "TIKTOK", slot: "NIGHT",
      uploadedAt: new Date(Date.now() + uploads * 1000), files: [{ name: "ZZTEST" }], flags: [],
      sales: {
        create: lines.map((l) => ({
          business, platform: "TIKTOK", show: "TikTok PM", showDate: toDbDate(day), shiftTag: "", rawShiftTag: "",
          orderRef: `ZZ-${l.order}`, lineRef: "1", buyer: "test", stockNumber: l.stock, modelNumber: l.model ?? "", qty: l.qty ?? 1,
          tracking: l.tracking, sourceFile: "ZZTEST",
        })),
      },
    },
  });
}
async function box(tracking: string, status: "OPEN" | "CLOSED_COMPLETE" | "CLOSED_INCOMPLETE", items: Record<string, number>, pieces: [string, string][] = []) {
  const existing = await prisma.package.findUnique({ where: { trackingNumber: tracking } });
  const b = existing
    ? await prisma.package.update({ where: { id: existing.id }, data: { status } })
    : await prisma.package.create({ data: { trackingNumber: tracking, platform: "TIKTOK", showDate: toDbDate(day), status } });
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
  check("what was sent stays sent", (await prisma.stockSale.findMany({ where: { orderRef: "ZZ-3" }, select: { status: true } })).map((s) => s.status), ["SENT"]);
  await setStartDate(boss.id, day);

  console.log("\nDiamonds.");
  await upload([{ order: "D1", stock: D1, tracking: "ZZT9" }], "DIAMOND");
  await bringStockUpToDate(boss.id);
  check("a diamond sale never touches watch stock", await prisma.stockSale.count({ where: { orderRef: "ZZ-D1" } }), 0);

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

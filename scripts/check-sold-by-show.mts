/**
 * The "when it sold" dropdown on the Inventory page, against a real database.
 *
 * The situations it will meet, run rather than reasoned about:
 *
 *   - a model with no sales: nothing listed
 *   - a corrected file uploaded again for the same show: only what the
 *     newest upload says, never the old and the new together
 *   - the same file uploaded twice: nothing twice
 *   - a random pull named by Model #, and one named only by the packing scan:
 *     listed under the watch it turned out to be, never under the listing
 *   - a model sold on TikTok and on eBay the same day: two lines
 *   - a sale before the start date: not listed
 *   - a diamond sale with the same stock number: not listed
 *   - an upload made while the page was open: shown when the row is opened
 *   - a night show dated tomorrow: listed, and counted by the Sold column too
 *   - a sale cancelled, or returned after shipping: no longer listed
 *   - what the dropdown adds up to is what the Sold column says
 *
 * Every model it makes starts ZZTEST-, every order ZZ-, every box ZZT; all of
 * it is removed at the end and the start date put back as it was. It refuses
 * to run if the development database has real sales in the last two weeks,
 * because setting a start date would take those off too.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-sold-by-show.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, toDbDate, todayISO } from "../src/lib/domain/dates";
import { bringStockUpToDate, getStartDate, setStartDate } from "../src/lib/server/deduction";
import { readReturn } from "../src/lib/domain/movements";
import type { Row } from "../src/lib/domain/movements";
import { saveCount } from "../src/lib/server/inventory";
import { saveReturns } from "../src/lib/server/movements";
import { modelSoldByShow, soldByModel } from "../src/lib/server/inventory-export";
import { getSettings } from "../src/lib/server/settings";

assertDevDatabase("check-sold-by-show.mts");

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
const dayBefore = addDays(today, -2);

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
  const entries = (await prisma.stockMove.findMany({ where: { productId: { in: products } }, select: { entryId: true } })).map((m) => m.entryId);
  await prisma.stockMove.deleteMany({ where: { OR: [{ productId: { in: products } }, { saleId: { in: sales } }] } });
  await prisma.stockSale.deleteMany({ where: { id: { in: sales } } });
  await prisma.stockEntry.deleteMany({ where: { id: { in: entries } } });
  const boxes = (await prisma.package.findMany({ where: { trackingNumber: { startsWith: "ZZT" } }, select: { id: true } })).map((b) => b.id);
  await prisma.scanEvent.deleteMany({ where: { packageId: { in: boxes } } });
  await prisma.packageItem.deleteMany({ where: { packageId: { in: boxes } } });
  await prisma.package.deleteMany({ where: { id: { in: boxes } } });
  await prisma.importBatch.deleteMany({ where: { files: { equals: [{ name: "ZZTEST" }] } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...products, ...entries] } } });
  await prisma.product.deleteMany({ where: { id: { in: products } } });
}

type Line = { order: string; stock: string; model?: string; qty?: number; tracking: string };
let uploads = 0;
/** One show's report, uploaded; each call is a newer upload of that checklist line. */
async function upload(
  lines: Line[],
  opts: { date?: string; platform?: "TIKTOK" | "EBAY"; slot?: "DAY" | "NIGHT" | null; show?: string; business?: "WATCH" | "DIAMOND" } = {},
) {
  const { date = day, platform = "TIKTOK", slot = "DAY", show = "TikTok AM", business = "WATCH" } = opts;
  uploads++;
  await prisma.importBatch.create({
    data: {
      business, showDate: toDbDate(date), status: "OK", platform, slot,
      uploadedAt: new Date(Date.now() + uploads * 1000), files: [{ name: "ZZTEST" }], flags: [],
      sales: {
        create: lines.map((l) => ({
          business, platform, show, showDate: toDbDate(date), shiftTag: "", rawShiftTag: "",
          orderRef: `ZZ-${l.order}`, lineRef: "1", buyer: "test", stockNumber: l.stock, modelNumber: l.model ?? "", qty: l.qty ?? 1,
          tracking: l.tracking, sourceFile: "ZZTEST", ...(platform === "EBAY" ? { paidOn: toDbDate(date) } : {}),
        })),
      },
    },
  });
}
const shown = async (model: string) => (await modelSoldByShow(model, boss!.id)).map((s) => `${s.day} ${s.show} ${s.sold}`);

const NONE = `${P}S100`, FIX = `${P}S200`, PULL = `${P}S300`, BOTH = `${P}S400`, SCAN = `${P}S500`;

try {
  await cleanUp();
  await setStartDate(boss.id, null);
  await saveCount(boss.id, [
    { model: NONE, counted: { SELLABLE: 3 }, allowNew: true },
    { model: FIX, counted: { SELLABLE: 5 }, allowNew: true },
    { model: PULL, counted: { RANDOM_PULLS: 3 }, allowNew: true },
    { model: BOTH, counted: { SELLABLE: 5 }, allowNew: true },
    { model: SCAN, counted: { RANDOM_PULLS: 2 }, allowNew: true },
  ], "check");

  // The day before the start date: never listed.
  await upload([{ order: "0", stock: BOTH, tracking: "ZZT0" }], { date: dayBefore });
  // The day's TikTok AM: FIX twice, a random pull named PULL, a random pull with no name yet, BOTH once.
  const AM: Line[] = [
    { order: "1", stock: FIX, tracking: "ZZT1" },
    { order: "2", stock: FIX, tracking: "ZZT2" },
    { order: "3", stock: PULLS, model: PULL, tracking: "ZZT3" },
    { order: "4", stock: PULLS, tracking: "ZZT4" },
    { order: "5", stock: BOTH, tracking: "ZZT5" },
  ];
  await upload(AM);
  // The same day on eBay: BOTH twice.
  await upload([{ order: "6", stock: BOTH, qty: 2, tracking: "ZZT6" }], { platform: "EBAY", slot: null, show: "eBay AM" });
  // A diamond sale under the same stock number: another business, never stock.
  await upload([{ order: "7", stock: BOTH, tracking: "ZZT7" }], { business: "DIAMOND" });

  await setStartDate(boss.id, day);
  await bringStockUpToDate(boss.id);

  console.log("The ordinary day.");
  check("a model with no sales: nothing listed", await shown(NONE), []);
  check("two sold at one show: one line of 2", await shown(FIX), [`${day} TikTok AM 2`]);
  check("a random pull named by Model #: under the watch, not the listing", await shown(PULL), [`${day} TikTok AM 1`]);
  check(
    "sold on TikTok and eBay the same day: two lines; the day before the start and the diamond sale not listed",
    await shown(BOTH),
    [`${day} eBay AM 2`, `${day} TikTok AM 1`],
  );

  console.log("\nUploaded again.");
  await upload(AM);
  await bringStockUpToDate(boss.id);
  check("the same file twice: nothing twice", await shown(FIX), [`${day} TikTok AM 2`]);
  await upload(AM.filter((l) => l.order !== "2"));
  await bringStockUpToDate(boss.id);
  check("a corrected file without one of the sales: only the newest upload counts", await shown(FIX), [`${day} TikTok AM 1`]);

  console.log("\nA random pull named only when it is packed.");
  check("before packing: under no model", await shown(SCAN), []);
  const b = await prisma.package.create({ data: { trackingNumber: "ZZT4", platform: "TIKTOK", showDate: toDbDate(day), status: "OPEN" } });
  await prisma.scanEvent.create({ data: { packageId: b.id, userId: boss.id, kind: "ITEM_PLACEHOLDER", stockNumber: SCAN, note: `Sold as: ${PULLS.toUpperCase()}` } });
  await bringStockUpToDate(boss.id);
  check("scanned into a box still open: not yet (stock waits for the box too)", await shown(SCAN), []);
  await prisma.package.update({ where: { id: b.id }, data: { status: "CLOSED_COMPLETE" } });
  await bringStockUpToDate(boss.id);
  check("its box closed with S500 scanned: listed under it", await shown(SCAN), [`${day} TikTok AM 1`]);

  console.log("\nThe dropdown and the Sold column agree.");
  const column = await soldByModel(day, today, today);
  const models = [NONE, FIX, PULL, BOTH, SCAN];
  const dropdown = await Promise.all(models.map(async (m) => (await modelSoldByShow(m, boss!.id)).reduce((n, s) => n + s.sold, 0)));
  check("same numbers, model by model", dropdown, models.map((m) => column.get(m) ?? 0));
  check("an unknown model: nothing, no error", await shown(`${P}NOPE`), []);

  console.log("\nAn upload made while the page was open.");
  // No run in between: opening the row must bring stock up to date itself.
  await upload(AM.filter((l) => l.order !== "2").map((l) => (l.order === "1" ? { ...l, qty: 2 } : l)));
  check("the newest upload shows when the row is opened, no reload", await shown(FIX), [`${day} TikTok AM 2`]);

  console.log("\nA night show that ran past midnight, dated tomorrow.");
  const tomorrow = addDays(today, 1);
  await upload([{ order: "8", stock: FIX, tracking: "ZZT8" }], { date: tomorrow, slot: "NIGHT", show: "TikTok PM" });
  check("listed first, under tomorrow", await shown(FIX), [`${tomorrow} TikTok PM 1`, `${day} TikTok AM 2`]);
  check("and the Sold column up to today counts it too", (await soldByModel(day, today, today)).get(FIX), 3);

  console.log("\nCancelled and returned by hand.");
  const ret = (row: Row) => {
    const r = readReturn(row);
    if (!r.ok) throw new Error(r.why);
    return r.ret;
  };
  const cancelled = await saveReturns(boss.id, [ret({ "Model #": BOTH, Quantity: 1, Type: "Cancelled", "Goes to": "Sellable", "Order #": "ZZ-5" })], "check");
  check("an order cancelled before it shipped: no longer listed", [cancelled.ok, await shown(BOTH)], [true, [`${day} eBay AM 2`]]);
  await prisma.package.create({
    data: { trackingNumber: "ZZT3", platform: "TIKTOK", showDate: toDbDate(day), status: "CLOSED_COMPLETE", items: { create: [{ stockNumber: PULL, expectedQty: 1, scannedQty: 1 }] } },
  });
  const b3 = await prisma.package.findUniqueOrThrow({ where: { trackingNumber: "ZZT3" } });
  await prisma.scanEvent.create({ data: { packageId: b3.id, userId: boss.id, kind: "ITEM_PLACEHOLDER", stockNumber: PULL, note: `Sold as: ${PULLS.toUpperCase()}` } });
  await bringStockUpToDate(boss.id);
  check("shipped", (await prisma.stockSale.findFirstOrThrow({ where: { orderRef: "ZZ-3" } })).status, "SENT");
  const returned = await saveReturns(boss.id, [ret({ "Model #": PULL, Quantity: 1, Type: "Back in stock", "Goes to": "Random pulls", "Order #": "ZZ-3" })], "check");
  check("returned after it shipped: no longer listed, like the Sold column", [returned.ok, await shown(PULL), (await soldByModel(day, today, today)).get(PULL) ?? 0], [true, [], 0]);
  const after = await soldByModel(day, today, today);
  const dropdownAfter = await Promise.all(models.map(async (m) => (await modelSoldByShow(m, boss!.id)).reduce((n, s) => n + s.sold, 0)));
  check("still the same numbers as the Sold column", dropdownAfter, models.map((m) => after.get(m) ?? 0));

  console.log("\nSwitched off.");
  await setStartDate(boss.id, null);
  check("no start date: nothing listed", await shown(FIX), []);
} finally {
  console.log("\nCleaning up.");
  await cleanUp();
  await setStartDate(boss.id, startBefore);
  console.log(`Removed — ${await prisma.product.count({ where: { model: { startsWith: P } } })} test model(s) left; start date back to ${startBefore ?? "off"}.`);
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll sold-by-show checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

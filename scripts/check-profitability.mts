/**
 * The Profitability tab against a real database: uploads, stock taken off with
 * its cost saved, and the figures read back the way the page reads them.
 *
 *   - an ordinary week: revenue, cost of goods, gross profit, margin, units
 *   - a cost changed after the sale (a new master): the sale keeps the cost it sold at
 *   - TikTok and eBay apart, day and night shows apart
 *   - a cancelled order: left out, and counted
 *   - a model with no cost: revenue counts, margin leaves it out
 *   - a day's file uploaded again, corrected: only the latest counts
 *   - diamond sales: never in these watch figures
 *   - one day agrees exactly with Morning numbers for that day
 *   - the period before: compared like for like
 *   - a slow mover (one a show at 20%) is flagged; a good seller is not
 *   - a period with no sales: empty, no error
 *
 * Models are ZZTEST-PROF-*, orders ZZ-P*. It refuses to run against anything
 * but a local database, and skips when the database holds real recent sales
 * (setting a start date would take them off stock too).
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-profitability.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, toDbDate, todayISO } from "../src/lib/domain/dates";
import { grossMargin, marginRate } from "../src/lib/domain/morning";
import { bringStockUpToDate, getStartDate, setStartDate } from "../src/lib/server/deduction";
import { saveCount } from "../src/lib/server/inventory";
import { getMorningNumbers } from "../src/lib/server/morning";
import { saveReturns } from "../src/lib/server/movements";
import { getProfitability } from "../src/lib/server/profit";
import { getSettings } from "../src/lib/server/settings";

assertDevDatabase("check-profitability.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const P = "ZZTEST-PROF-";
const A = `${P}A`, B = `${P}B`, SLOW = `${P}SLOW`, NOCOST = `${P}N`;
const today = todayISO((await getSettings()).timezone);
const d = (n: number) => addDays(today, n - 8); // d(1) … d(7) = the seven days before today

const boss = await prisma.user.findFirst({ where: { role: "BOSS", isActive: true }, select: { id: true } });
if (!boss) {
  console.log("SKIP  needs an admin account. Run the seed first.");
  await prisma.$disconnect();
  process.exit(0);
}
const realSales = await prisma.salesRecord.count({
  where: { showDate: { gte: toDbDate(addDays(today, -30)) }, NOT: { orderRef: { startsWith: "ZZ-" } } },
});
if (realSales > 0) {
  console.log(`SKIP  the development database has ${realSales} real sale(s) this month; setting a start date would take them off too.`);
  await prisma.$disconnect();
  process.exit(0);
}
const startBefore = await getStartDate();

async function cleanUp() {
  const products = (await prisma.product.findMany({ where: { model: { startsWith: P } }, select: { id: true } })).map((p) => p.id);
  const sales = (await prisma.stockSale.findMany({ where: { OR: [{ productId: { in: products } }, { orderRef: { startsWith: "ZZ-P" } }] }, select: { id: true } })).map((s) => s.id);
  const entries = (await prisma.stockMove.findMany({ where: { productId: { in: products } }, select: { entryId: true } })).map((m) => m.entryId);
  await prisma.stockMove.deleteMany({ where: { OR: [{ productId: { in: products } }, { saleId: { in: sales } }] } });
  await prisma.stockSale.deleteMany({ where: { id: { in: sales } } });
  await prisma.stockEntry.deleteMany({ where: { id: { in: entries } } });
  await prisma.importBatch.deleteMany({ where: { files: { equals: [{ name: "ZZTEST-PROFIT" }] } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...products, ...entries] } } });
  await prisma.product.deleteMany({ where: { id: { in: products } } });
}

type Line = { order: string; stock: string; cents: number };
let uploads = 0;
async function upload(
  date: string,
  platform: "TIKTOK" | "EBAY",
  slot: "DAY" | "NIGHT" | null,
  lines: Line[],
  business: "WATCH" | "DIAMOND" = "WATCH",
) {
  uploads++;
  const show = platform === "EBAY" ? "eBay AM" : slot === "DAY" ? "TikTok AM" : "TikTok PM";
  await prisma.importBatch.create({
    data: {
      business, showDate: toDbDate(date), status: "OK", platform, slot,
      uploadedAt: new Date(Date.now() + uploads * 1000), files: [{ name: "ZZTEST-PROFIT" }], flags: [],
      sales: {
        create: lines.map((l) => ({
          business, platform, show, showDate: toDbDate(date), shiftTag: "", rawShiftTag: "",
          orderRef: `ZZ-P${l.order}`, lineRef: "1", buyer: "test", stockNumber: l.stock, modelNumber: "", qty: 1,
          netItemPriceCents: l.cents, tracking: "", sourceFile: "ZZTEST",
        })),
      },
    },
  });
}

try {
  await cleanUp();
  await setStartDate(boss.id, null);
  await prisma.product.createMany({
    data: [
      { model: A, description: "A", costCents: 2_000 },
      { model: B, description: "B", costCents: 1_000 },
      { model: SLOW, description: "slow", costCents: 4_000 },
      { model: NOCOST, description: "no cost" },
    ],
  });
  check("counted in", (await saveCount(boss.id, [A, B, SLOW, NOCOST].map((m) => ({ model: m, counted: { SELLABLE: 50 } })), "check-profitability")).ok, true);

  // Seven days. Each night: two of A at $50, one SLOW at $50 (20% margin).
  for (let i = 1; i <= 7; i++) {
    await upload(d(i), "TIKTOK", "NIGHT", [
      { order: `${i}a`, stock: A, cents: 5_000 },
      { order: `${i}b`, stock: A, cents: 5_000 },
      { order: `${i}s`, stock: SLOW, cents: 5_000 },
    ]);
  }
  // Day 7 also: a TikTok day show with B and a no-cost model; an eBay sale of B; a diamond sale.
  await upload(d(7), "TIKTOK", "DAY", [{ order: "7d", stock: B, cents: 2_500 }, { order: "7n", stock: NOCOST, cents: 4_000 }]);
  await upload(d(7), "EBAY", null, [{ order: "7e", stock: B, cents: 3_000 }]);
  await upload(d(7), "TIKTOK", "NIGHT", [{ order: "7x", stock: A, cents: 999_999 }], "DIAMOND");

  await setStartDate(boss.id, d(1));
  await bringStockUpToDate(boss.id);

  // A new master changes A's cost after the sales: the sales keep $20.
  await prisma.product.update({ where: { model: A }, data: { costCents: 9_999 } });

  let p = await getProfitability(d(1), d(7));
  let t = p.current.total;
  // 14 A × $50 + 7 SLOW × $50 + B $25 + no-cost $40 + B eBay $30.
  check("revenue: watches only, diamonds left out", t.revenueCents, 14 * 5_000 + 7 * 5_000 + 2_500 + 4_000 + 3_000);
  check("units", t.units, 14 + 7 + 3);
  check("cost of goods: each sale at the cost it sold at, not today's", t.cogsCents, 14 * 2_000 + 7 * 4_000 + 2 * 1_000);
  check("a model with no cost: revenue counts, margin leaves it out", [t.uncostedUnits, t.costedRevenueCents], [1, t.revenueCents - 4_000]);
  check("gross profit", grossMargin(t), t.costedRevenueCents - t.cogsCents);
  check("TikTok and eBay apart", [p.current.byPlatform.get("TIKTOK")?.units, p.current.byPlatform.get("EBAY")?.units], [23, 1]);
  check("day and night shows apart", [p.current.byShow.get("TikTok AM")?.units, p.current.byShow.get("TikTok PM")?.units], [2, 21]);
  check("A by model: 14 units at 60%", [p.current.byModel.get(A)?.units, Math.round((marginRate(p.current.byModel.get(A)!) ?? 0) * 100)], [14, 60]);

  check("a slow mover is flagged", p.slow.map((s) => s.model), [SLOW]);
  check("…one a show, at 20%", [p.slow[0]?.unitsPerShow, Math.round((p.slow[0]?.margin ?? 0) * 100)], [1, 20]);

  // One day agrees with Morning numbers for that day.
  const morning = (await getMorningNumbers(d(7))).day.total;
  const day7 = p.current.byDay.get(d(7))!;
  check("day 7 agrees exactly with Morning numbers", [day7.revenueCents, day7.cogsCents, day7.units], [morning.revenueCents, morning.cogsCents, morning.units]);

  // Cancelled after payment.
  const cancel = await saveReturns(boss.id, [{ model: B, qty: 1, type: "Back in stock", to: "SELLABLE", order: "ZZ-P7e", note: "check-profitability" }], "check-profitability");
  check("the eBay order of B cancelled", cancel.ok, true);
  p = await getProfitability(d(1), d(7));
  check("a cancelled order is left out, and counted", [p.current.total.units, p.current.total.cancelledUnits, p.current.total.cancelledCents], [23, 1, 3_000]);

  // Day 7's night file uploaded again, corrected: A now at $40.
  await upload(d(7), "TIKTOK", "NIGHT", [
    { order: "7a", stock: A, cents: 4_000 },
    { order: "7b", stock: A, cents: 4_000 },
    { order: "7s", stock: SLOW, cents: 5_000 },
  ]);
  p = await getProfitability(d(7), d(7));
  check("a corrected upload: only the latest counts", p.current.byModel.get(A)?.revenueCents, 8_000);

  // Order 1a's report filed again three weeks later (a file put under the wrong
  // day, corrected): the sale keeps the cost it was taken off at, not today's.
  const later = addDays(d(1), 21);
  await upload(later, "TIKTOK", "NIGHT", [{ order: "1a", stock: A, cents: 5_000 }]);
  p = await getProfitability(later, later);
  check(
    "a report re-filed three weeks later keeps the sale's saved cost",
    [p.current.total.units, p.current.total.cogsCents, p.current.total.estimatedUnits],
    [1, 2_000, 0],
  );

  // The period before: days 4–7 against days 0–3.
  p = await getProfitability(d(4), d(7));
  check("the period before is the same length, just before", p.previous, { from: d(0), to: d(3) });
  check("…and compares like for like (3 nights of sales in it)", p.previousTotal.units, 9);

  p = await getProfitability(addDays(today, 400), addDays(today, 410));
  check("a period with no sales: empty, no error", [p.current.total.units, p.slow.length], [0, 0]);
} finally {
  await cleanUp();
  await setStartDate(boss.id, startBefore);
}

console.log(`\n${failures === 0 ? "All passed." : `${failures} failed.`} Fixtures removed.`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);

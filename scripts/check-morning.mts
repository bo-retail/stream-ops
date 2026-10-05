/**
 * Inventory step 6 — the morning numbers — against a real database.
 *
 * The situations it will meet, run rather than reasoned about:
 *
 *   - a day before the start date: every unit costed at today's cost, and said
 *   - from the start date: each unit at the cost snapshot stock deduction took,
 *     matched unit by unit (an order with a line of two and a second line)
 *   - the model's cost changed afterwards (a correction): the day already
 *     reported does not move
 *   - a random pull named by its Model #: costed as that watch
 *   - a model with no cost: revenue counted, margin left out, said
 *   - an order cancelled before it shipped: left out of the day, counted
 *   - the same report uploaded again, corrected: the latest only, nothing twice
 *   - the same order in two current files (overlapping downloads): once
 *   - diamond sales the same day: not in the watch numbers
 *   - a published show whose report is not in yet: named
 *   - a day with no shows: nothing, no error
 *
 * Every model it makes starts ZZTEST-, every order ZZ-; all of it is removed
 * at the end and the start date put back. It refuses to run if the development
 * database has real sales in the last two weeks (a start date would take them off).
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-morning.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, toDbDate, todayISO } from "../src/lib/domain/dates";
import { marginRate } from "../src/lib/domain/morning";
import { bringStockUpToDate, getStartDate, setStartDate } from "../src/lib/server/deduction";
import { saveCount } from "../src/lib/server/inventory";
import { getMorningNumbers } from "../src/lib/server/morning";
import { saveReturns } from "../src/lib/server/movements";
import { getSettings } from "../src/lib/server/settings";

assertDevDatabase("check-morning.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const P = "ZZTEST-MORN-";
const A = `${P}A`, B = `${P}B`, C = `${P}C`, NOCOST = `${P}N`;
const PULLS = "#300 - Invicta Random Pulls";
const today = todayISO((await getSettings()).timezone);
const before = addDays(today, -3);
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
  const sales = (await prisma.stockSale.findMany({ where: { OR: [{ productId: { in: products } }, { orderRef: { startsWith: "ZZ-M" } }] }, select: { id: true } })).map((s) => s.id);
  const entries = (await prisma.stockMove.findMany({ where: { productId: { in: products } }, select: { entryId: true } })).map((m) => m.entryId);
  await prisma.stockMove.deleteMany({ where: { OR: [{ productId: { in: products } }, { saleId: { in: sales } }] } });
  await prisma.stockSale.deleteMany({ where: { id: { in: sales } } });
  await prisma.stockEntry.deleteMany({ where: { id: { in: entries } } });
  await prisma.importBatch.deleteMany({ where: { files: { equals: [{ name: "ZZTEST-MORNING" }] } } });
  await prisma.release.deleteMany({ where: { name: { startsWith: "ZZTEST morning" } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...products, ...entries] } } });
  await prisma.product.deleteMany({ where: { id: { in: products } } });
}

type Line = { order: string; stock: string; model?: string; qty?: number; cents: number; lineRef?: string };
let uploads = 0;
async function upload(date: string, slot: "DAY" | "NIGHT", lines: Line[], business: "WATCH" | "DIAMOND" = "WATCH") {
  uploads++;
  await prisma.importBatch.create({
    data: {
      business, showDate: toDbDate(date), status: "OK", platform: "TIKTOK", slot,
      uploadedAt: new Date(Date.now() + uploads * 1000), files: [{ name: "ZZTEST-MORNING" }], flags: [],
      sales: {
        create: lines.map((l) => ({
          business, platform: "TIKTOK", show: slot === "DAY" ? "TikTok AM" : "TikTok PM", showDate: toDbDate(date), shiftTag: "", rawShiftTag: "",
          orderRef: `ZZ-M${l.order}`, lineRef: l.lineRef ?? "1", buyer: "test", stockNumber: l.stock, modelNumber: l.model ?? "", qty: l.qty ?? 1,
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
      { model: C, description: "C (random pull)", costCents: 500 },
      { model: NOCOST, description: "no cost" },
    ],
  });
  check("counted in", (await saveCount(boss.id, [...[A, B, NOCOST].map((m) => ({ model: m, counted: { SELLABLE: 20 } })), { model: C, counted: { RANDOM_PULLS: 5 } }], "check-morning")).ok, true);

  /* ----------------------------------------------- before the start date */
  await upload(before, "NIGHT", [{ order: "0", stock: A, cents: 5_000 }]);
  let n = await getMorningNumbers(before);
  check("before the start date: costed at today's cost, and counted as such", [n.day.total.cogsCents, n.day.total.estimatedUnits], [2_000, 1]);

  /* ------------------------------------------------ from the start date */
  await upload(day, "DAY", [
    { order: "1", stock: A, qty: 2, cents: 10_000 },
    { order: "1", stock: A, cents: 6_000, lineRef: "2" },
    { order: "2", stock: PULLS, model: C, cents: 3_000 },
    { order: "3", stock: NOCOST, cents: 4_000 },
  ]);
  await upload(day, "NIGHT", [{ order: "4", stock: B, cents: 2_500 }, { order: "5", stock: B, cents: 2_500 }]);
  await upload(day, "NIGHT", [{ order: "9", stock: A, cents: 99_999 }], "DIAMOND");
  await setStartDate(boss.id, day);
  await bringStockUpToDate(boss.id);
  // Give A's three units three different snapshots, to prove each is matched to its own.
  const aSales = await prisma.stockSale.findMany({ where: { orderRef: "ZZ-M1" }, orderBy: { key: "asc" }, select: { id: true, key: true } });
  check("three sold units of A in order 1", aSales.length, 3);
  for (const [i, s] of aSales.entries()) await prisma.stockSale.update({ where: { id: s.id }, data: { costCents: 2_000 + i * 100 } });

  n = await getMorningNumbers(day);
  const t = n.day.total;
  check("revenue: watches only, diamonds left out", t.revenueCents, 10_000 + 6_000 + 3_000 + 4_000 + 5_000);
  check("units", t.units, 7);
  check("each of A's units at its own snapshot (2000 + 2100 + 2200), the pull at C's, B at B's", t.cogsCents, 6_300 + 500 + 2_000);
  check("nothing estimated: every costed unit has a snapshot", t.estimatedUnits, 0);
  check("the model with no cost: revenue in, margin out, counted", [t.uncostedUnits, t.costedRevenueCents], [1, 24_000]);
  check("the AM and PM split", [n.day.byShow.get("TikTok AM")!.revenueCents, n.day.byShow.get("TikTok PM")!.revenueCents], [23_000, 5_000]);
  const margin = marginRate(t);

  /* --------------------------------------- the cost changes afterwards */
  await prisma.product.update({ where: { model: A }, data: { costCents: 9_000 } });
  n = await getMorningNumbers(day);
  check("a later cost change does not move the day already reported", marginRate(n.day.total), margin);

  /* ------------------------------------------- a cancellation, unshipped */
  const cancel = await saveReturns(boss.id, [{ model: B, qty: 1, type: "Back in stock", to: "SELLABLE", order: "ZZ-M5", note: "check-morning" }], "check-morning");
  check("order 5 cancelled before shipping", cancel.ok, true);
  n = await getMorningNumbers(day);
  check("…left out of the day, and counted", [n.day.total.revenueCents, n.day.total.units, n.day.total.cancelledUnits], [25_500, 6, 1]);

  /* --------------------------------------- the same report, corrected */
  await upload(day, "NIGHT", [{ order: "4", stock: B, cents: 2_400 }, { order: "5", stock: B, cents: 2_500 }]);
  await bringStockUpToDate(boss.id);
  n = await getMorningNumbers(day);
  check("the PM report uploaded again: the latest only, nothing twice", n.day.byShow.get("TikTok PM")!.revenueCents, 2_400);

  /* ------------------------ the same order in two current files (overlap) */
  // Order 4 also turns up in the AM file (downloads that overlap): one watch, read from the latest file.
  await upload(day, "DAY", [
    { order: "1", stock: A, qty: 2, cents: 10_000 },
    { order: "1", stock: A, cents: 6_000, lineRef: "2" },
    { order: "2", stock: PULLS, model: C, cents: 3_000 },
    { order: "3", stock: NOCOST, cents: 4_000 },
    { order: "4", stock: B, cents: 2_400 },
  ]);
  await bringStockUpToDate(boss.id);
  n = await getMorningNumbers(day);
  check("an order in two current files counts once", [n.day.total.units, n.day.total.revenueCents], [6, 25_400]);

  /* ------------------------------------- reports missing, days with none */
  await prisma.release.create({
    data: {
      name: "ZZTEST morning", startDate: toDbDate(today), endDate: toDbDate(today), status: "CLOSED", scheduleStatus: "PUBLISHED",
      shows: { create: [{ date: toDbDate(today), platform: "EBAY", slot: "NIGHT", startsAt: new Date(`${today}T23:00:00Z`), endsAt: new Date(`${today}T23:59:00Z`) }] },
    },
  });
  n = await getMorningNumbers(today);
  check("a published show with no report yet is named", n.missingReports, ["eBay"]);
  check("…and a day with nothing gives nothing", [n.day.total.units, n.day.total.revenueCents], [0, 0]);
  check("the week runs back seven days, the day itself last", [n.week.length, n.week[6].date], [7, today]);
} finally {
  await cleanUp();
  await setStartDate(boss.id, startBefore);
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll passed." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);

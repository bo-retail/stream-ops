/**
 * The sales figures, against a real day.
 *
 * The one that matters most is the last: a day uploaded twice must not double
 * its revenue. Every figure on the insights page reads through the same
 * latest-upload-per-day rule as the workbook, and this proves they agree.
 *
 *   STREAMOPS_IMPORT_FIXTURES=<folder with one day's three exports> \
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-insights.mts
 */
import "dotenv/config";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/db";
import { runImport } from "../src/lib/server/imports";
import { getSalesInsights, salesHeadline } from "../src/lib/server/insights";
import { latestBatchIds } from "../src/lib/server/sales-data";

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

const DAY = "2026-09-08";
const showDate = new Date(`${DAY}T00:00:00.000Z`);

async function clearDay() {
  await prisma.scanEvent.deleteMany({ where: { package: { showDate } } });
  await prisma.packageItem.deleteMany({ where: { package: { showDate } } });
  await prisma.package.deleteMany({ where: { showDate } });
  await prisma.importBatch.deleteMany({ where: { showDate } });
}
await clearDay();

await runImport(files, user.id);
console.log(`Imported ${DAY}.\n`);

/* ------------------------------------------------------------- the totals */

const one = await getSalesInsights(DAY, DAY);

check("it has data", one.hasData, true);
check("473 watches", one.totals.units, 473);
check("net revenue matches the workbook's headline", one.totals.revenueCents, 1_853_820);
// 219 people, not the 235 the workbook's total used to read: that summed each
// show's buyer count, so anybody who bought in two shows was counted twice.
check("219 distinct buyers", one.totals.buyers, 219);
check(
  "the average price is revenue over units",
  one.totals.avgPriceCents,
  Math.round(1_853_820 / 473),
);

/* ------------------------------------------------------------ the splits */

// Ordered by revenue: TikTok PM $7,369, TikTok AM $5,945, eBay $5,224.
check(
  "three shows, biggest earner first",
  one.byShow.map((s) => s.key),
  ["TikTok PM", "TikTok AM", "eBay PM"],
);
check(
  "the shares add up to a hundred",
  Math.round(one.byShow.reduce((n, s) => n + s.sharePercent, 0)),
  100,
);
check(
  "two marketplaces",
  one.byPlatform.map((p) => p.key).sort(),
  ["TikTok", "eBay"],
);
check(
  "TikTok is 307 watches",
  one.byPlatform.find((p) => p.key === "TikTok")?.units,
  307,
);
check("eBay is 166", one.byPlatform.find((p) => p.key === "eBay")?.units, 166);

// Day against night, read off the show names. On this day the AM show is the
// only day show; everything else is night.
check(
  "day and night both appear",
  one.bySlot.map((s) => s.key).sort(),
  ["Day", "Night"],
);
check("the day show is 164 watches", one.bySlot.find((s) => s.key === "Day")?.units, 164);
check("the night shows are 309", one.bySlot.find((s) => s.key === "Night")?.units, 309);
check(
  "and together they are the whole day",
  one.bySlot.reduce((n, s) => n + s.units, 0),
  473,
);

/* --------------------------------------------------------- best sellers */

check("best sellers are listed", one.bestSellers.length > 0, true);
check(
  "most units first",
  one.bestSellers.every((m, i) => i === 0 || m.units <= one.bestSellers[i - 1].units),
  true,
);
check(
  "the top one is hot",
  one.bestSellers[0].hot,
  true,
);
check(
  "and its all-time count is at least what it sold today",
  one.bestSellers[0].allTimeUnits >= one.bestSellers[0].units,
  true,
);

/* ------------------------------------------------------------- the shape */

check("one day in the range means one point", one.daily.length, 1);
check("with the day's revenue on it", one.daily[0].revenueCents, 1_853_820);
check("the latest loaded day is that day", one.latestDay?.dateISO, DAY);
check("one selling day", one.daysWithSales, 1);

// A range wider than the data keeps its empty days rather than closing up, so
// a gap in the chart reads as a gap.
const week = await getSalesInsights("2026-09-02", "2026-09-08");
check("a week has seven points", week.daily.length, 7);
check("six of them empty", week.daily.filter((d) => d.units === 0).length, 6);
check("but only one selling day counted", week.daysWithSales, 1);

/* ------------------------------- the one that matters: a re-uploaded day */

await runImport(files, user.id);
check(
  "two uploads are on record",
  await prisma.importBatch.count({ where: { showDate, status: "OK" } }),
  2,
);
check(
  "and both kept their sales rows",
  await prisma.salesRecord.count({ where: { showDate } }),
  946,
);
check("but only one batch is read", (await latestBatchIds(DAY, DAY)).length, 1);

const after = await getSalesInsights(DAY, DAY);
check("revenue did not double", after.totals.revenueCents, 1_853_820);
check("nor did the watches", after.totals.units, 473);
check("nor the buyers", after.totals.buyers, 219);

/* -------------------------------------------------------- the dashboard */

const headline = await salesHeadline(90);
check("the dashboard figure reads the same data", headline.units >= 473, true);
check("and ends yesterday, never today", headline.to < new Date().toISOString().slice(0, 10), true);

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleaning up.");
await clearDay();
console.log(`Removed — ${await prisma.salesRecord.count({ where: { showDate } })} sales rows left.`);

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll insights checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

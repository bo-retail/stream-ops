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
import {
  DEFAULT_PERIOD,
  getSalesInsights,
  rangePresets,
  resolveRange,
  salesHeadline,
} from "../src/lib/server/insights";
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

/**
 * Whatever is already there stays there.
 *
 * An earlier version of this script cleared the day before running and deleted
 * a real upload with it — along with any packing done against it. It does not
 * need to: every figure reads only the most recent upload for a day, so an
 * older one changes nothing. The two counting checks are taken against this
 * baseline instead, and the cleanup at the end removes only what this run made.
 */
const existing = await prisma.importBatch.findMany({
  where: { showDate },
  select: { id: true, status: true },
});
const existingIds = existing.map((b) => b.id);
const existingOk = existing.filter((b) => b.status === "OK").length;
const existingRows = await prisma.salesRecord.count({ where: { showDate } });
const existingPackages = await prisma.package.count({ where: { showDate } });

if (existing.length > 0) {
  console.log(
    `${existing.length} upload(s) already on ${DAY}. Leaving them alone and counting from there.`,
  );
}

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
  (await prisma.importBatch.count({ where: { showDate, status: "OK" } })) - existingOk,
  2,
);
check(
  "and both kept their sales rows",
  (await prisma.salesRecord.count({ where: { showDate } })) - existingRows,
  946,
);
check("but only one batch is read", (await latestBatchIds(DAY, DAY)).length, 1);

const after = await getSalesInsights(DAY, DAY);
check("revenue did not double", after.totals.revenueCents, 1_853_820);
check("nor did the watches", after.totals.units, 473);
check("nor the buyers", after.totals.buyers, 219);

/* ----------------------------------------------------------- the periods */

const presets = await rangePresets();
const yesterday = presets[0];

check("yesterday is the first period offered", yesterday.label, "Yesterday");
check("and it is a single day", yesterday.from === yesterday.to, true);
check(
  "which is yesterday, never today",
  yesterday.to < new Date().toISOString().slice(0, 10),
  true,
);
check(
  "every period ends on the same day",
  presets.slice(0, 4).every((p) => p.to === yesterday.to),
  true,
);

// Resolved by key, not by position: adding "Yesterday" at the front must not
// have quietly moved what the page opens on from 30 days to 7.
check(
  "no period asked for opens on 30 days",
  resolveRange(presets, undefined, undefined, undefined).key,
  DEFAULT_PERIOD,
);
check(
  "an unrecognised period falls back to the same",
  resolveRange(presets, "nonsense", undefined, undefined).key,
  DEFAULT_PERIOD,
);
check(
  "asking for yesterday gets one day",
  resolveRange(presets, "1", undefined, undefined).from,
  yesterday.to,
);
check(
  "a custom range wins over a period",
  resolveRange(presets, "30", "2026-09-01", "2026-09-08").key,
  "custom",
);
check(
  "a backwards custom range is ignored",
  resolveRange(presets, "7", "2026-09-08", "2026-09-01").key,
  "7",
);

// Yesterday's figures compare against the day before it — a one-day range must
// not silently compare against a week.
const oneDayBack = await getSalesInsights(DAY, DAY);
check("a single day compares with the day before", oneDayBack.previous.from, "2026-09-07");
check("and only that day", oneDayBack.previous.to, "2026-09-07");

/* -------------------------------------------------------- the dashboard */

const headline = await salesHeadline(90);
check("the dashboard figure reads the same data", headline.units >= 473, true);
check("and ends yesterday, never today", headline.to < new Date().toISOString().slice(0, 10), true);

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleaning up.");

// Only what this run created. Sales rows cascade from their batch; the packages
// go only if the day had none to begin with, because a re-upload updates an
// existing box's expected counts rather than replacing the box.
await prisma.importBatch.deleteMany({
  where:
    existingIds.length > 0 ? { showDate, id: { notIn: existingIds } } : { showDate },
});
if (existingPackages === 0) {
  await prisma.scanEvent.deleteMany({ where: { package: { showDate } } });
  await prisma.packageItem.deleteMany({ where: { package: { showDate } } });
  await prisma.package.deleteMany({ where: { showDate } });
}

const leftRows = await prisma.salesRecord.count({ where: { showDate } });
console.log(
  `Removed this run's uploads — ${leftRows} sales row(s) left on ${DAY}` +
    (existingRows > 0 ? ` (${existingRows} were here before).` : "."),
);
if (leftRows !== existingRows) {
  console.log(`FAIL  cleanup left ${leftRows} rows where ${existingRows} were before.`);
  failures++;
}

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll insights checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

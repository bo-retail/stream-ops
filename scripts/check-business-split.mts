/**
 * Watches and diamonds are counted apart, on Sales insights, on the dashboard
 * and in the downloaded workbook.
 *
 * Flora, 09/28: the "Every day" table read 654 "watches" at $45.85 because the
 * count had diamond pieces in it, and the workbook put a diamond "TikTok AM" and
 * a watch "TikTok AM" on one row. This loads real days (at least one with both
 * businesses) and checks every figure against the rows themselves.
 *
 *   STREAMOPS_SPLIT_FIXTURES=<folder with one sub-folder of exports per show day> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-business-split.mts
 *
 * Runs only against a development database, and removes only what it created.
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "../src/lib/db";
import { parseCsv } from "../src/lib/domain/imports/csv";
import { runImport } from "../src/lib/server/imports";
import { getSalesInsights, salesHeadline } from "../src/lib/server/insights";
import { latestBatchIds } from "../src/lib/server/sales-data";
import { buildSalesWorkbook } from "../src/lib/server/sales-workbook";

assertDevDatabase("check-business-split.mts");

const dir = process.env.STREAMOPS_SPLIT_FIXTURES;
if (!dir || !existsSync(dir)) {
  console.log("SKIP  set STREAMOPS_SPLIT_FIXTURES to a folder of show-day sub-folders.");
  process.exit(0);
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const boss = await prisma.user.findFirst({ where: { role: "BOSS", isActive: true }, select: { id: true } });
if (!boss) {
  console.log("SKIP  need an active boss account. Run the seed first.");
  process.exit(0);
}

const dayFolders = readdirSync(dir)
  .map((name) => join(dir, name))
  .filter((p) => statSync(p).isDirectory())
  .sort();

// Everything that exists before, so cleanup removes only this run's rows.
const batchesBefore = new Set((await prisma.importBatch.findMany({ select: { id: true } })).map((b) => b.id));
const packagesBefore = new Set((await prisma.package.findMany({ select: { id: true } })).map((p) => p.id));

const days: string[] = [];
const firstFileOfDay = new Map<string, { name: string; text: string }[]>();

try {
  /* -------------------------------------------------------------- loading */

  for (const folder of dayFolders) {
    const files = readdirSync(folder)
      .filter((f) => f.toLowerCase().endsWith(".csv"))
      .map((name) => ({ name, text: readFileSync(join(folder, name), "utf8") }));
    // One file at a time, as they arrive on the checklist.
    for (const file of files) {
      const out = await runImport([file], boss.id);
      if (out.status !== "OK") {
        console.log(`FAIL  ${file.name} was refused: ${out.flags.map((f) => f.message).join(" / ")}`);
        failures++;
        continue;
      }
      if (out.showDate && !days.includes(out.showDate)) days.push(out.showDate);
    }
    firstFileOfDay.set(folder, files);
  }
  days.sort();
  console.log(`Loaded ${days.join(", ")}.\n`);

  /** What the rows themselves say, for one day or a range: the answer key. */
  async function truth(from: string, to: string) {
    const ids = await latestBatchIds(from, to);
    const rows = await prisma.salesRecord.groupBy({
      by: ["business"],
      where: { batchId: { in: ids } },
      _sum: { qty: true, netItemPriceCents: true },
    });
    const of = (b: "WATCH" | "DIAMOND") => {
      const r = rows.find((x) => x.business === b);
      return { units: r?._sum.qty ?? 0, revenue: r?._sum.netItemPriceCents ?? 0 };
    };
    return { watch: of("WATCH"), diamond: of("DIAMOND") };
  }

  const mixedDays: string[] = [];
  for (const day of days) {
    const t = await truth(day, day);
    if (t.watch.units > 0 && t.diamond.units > 0) mixedDays.push(day);
  }
  check("the fixtures include a day with both watches and diamonds", mixedDays.length > 0, true);
  if (mixedDays.length === 0) throw new Error("Need a day with both businesses: add one to the fixtures.");

  /* ----------------------------------------------------- one day at a time */

  for (const day of days) {
    const t = await truth(day, day);
    const i = await getSalesInsights(day, day);
    console.log(`\n${day}: ${t.watch.units} watches, ${t.diamond.units} diamond pieces`);
    check(`${day} · watches sold counts watches only`, i.totals.units, t.watch.units);
    check(`${day} · watch revenue is watches only`, i.totals.revenueCents, t.watch.revenue);
    check(
      `${day} · the average watch price is watch revenue over watches`,
      i.totals.avgPriceCents,
      t.watch.units ? Math.round(t.watch.revenue / t.watch.units) : 0,
    );
    check(`${day} · diamond pieces are counted on their own`, i.diamonds.units, t.diamond.units);
    check(`${day} · diamond revenue on its own`, i.diamonds.revenueCents, t.diamond.revenue);
    check(`${day} · both together is the two added`, i.revenueBothCents, t.watch.revenue + t.diamond.revenue);
    const point = i.daily.find((d) => d.dateISO === day);
    check(`${day} · the Every day row: watches`, point?.watches, t.watch.units);
    check(`${day} · the Every day row: pieces`, point?.diamondPieces, t.diamond.units);
    check(`${day} · the Every day row: watch revenue`, point?.watchRevenueCents, t.watch.revenue);
    check(`${day} · the chart still shows the whole day`, point?.revenueCents, t.watch.revenue + t.diamond.revenue);

    const watchSlots = i.bySlot.filter((s) => !s.key.startsWith("Diamond")).reduce((n, s) => n + s.units, 0);
    const diamondSlots = i.bySlot.filter((s) => s.key.startsWith("Diamond")).reduce((n, s) => n + s.units, 0);
    check(`${day} · day and night: the watch lines hold only watches`, watchSlots, t.watch.units);
    check(`${day} · day and night: diamonds on their own lines`, diamondSlots, t.diamond.units);

    const diamondStock = new Set(
      (await prisma.salesRecord.findMany({
        where: { batchId: { in: await latestBatchIds(day, day) }, business: "DIAMOND" },
        select: { stockNumber: true },
      })).map((r) => r.stockNumber),
    );
    const watchStock = new Set(
      (await prisma.salesRecord.findMany({
        where: { batchId: { in: await latestBatchIds(day, day) }, business: "WATCH" },
        select: { stockNumber: true },
      })).map((r) => r.stockNumber),
    );
    check(
      `${day} · best sellers are watches only`,
      i.bestSellers.every((m) => watchStock.has(m.stockNumber) || !diamondStock.has(m.stockNumber)),
      true,
    );
  }

  /* -------------------------------------------- the bug Flora saw, measured */

  for (const day of mixedDays) {
    const t = await truth(day, day);
    const mixedAverage = Math.round((t.watch.revenue + t.diamond.revenue) / (t.watch.units + t.diamond.units));
    const i = await getSalesInsights(day, day);
    console.log(
      `\n${day}: the old average over everything was $${(mixedAverage / 100).toFixed(2)}; watches alone average $${(i.totals.avgPriceCents / 100).toFixed(2)}.`,
    );
    check(`${day} · the average is no longer the mixed one`, i.totals.avgPriceCents !== mixedAverage, true);
  }

  /* -------------------------------------------------------------- a range */

  const from = days[0];
  const to = days[days.length - 1];
  const all = await truth(from, to);
  const range = await getSalesInsights(from, to);
  check("the range · watches", range.totals.units, all.watch.units);
  check("the range · pieces", range.diamonds.units, all.diamond.units);
  check(
    "the range · every day adds up to the range",
    range.daily.reduce((n, d) => n + d.watches, 0),
    all.watch.units,
  );

  /* --------------------------------------------- a report uploaded again */

  const reuploadDay = mixedDays[0];
  const before = await getSalesInsights(reuploadDay, reuploadDay);
  for (const files of firstFileOfDay.values()) {
    for (const file of files) {
      const out = await runImport([file], boss.id);
      if (out.showDate !== reuploadDay) continue;
    }
  }
  const after = await getSalesInsights(reuploadDay, reuploadDay);
  check("uploaded again · watches did not double", after.totals.units, before.totals.units);
  check("uploaded again · pieces did not double", after.diamonds.units, before.diamonds.units);
  check("uploaded again · revenue did not double", after.revenueBothCents, before.revenueBothCents);

  /* ---------------------------------------------------------- the dashboard */

  const headline = await salesHeadline(90);
  const window = await truth(headline.from, headline.to);
  check("dashboard · watches sold is watches only", headline.units, window.watch.units);
  check("dashboard · revenue is both businesses", headline.revenueCents, window.watch.revenue + window.diamond.revenue);

  /* ---------------------------------------------------------- the workbook */

  const built = await buildSalesWorkbook(from, to);
  check("workbook · built", built !== null, true);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(built!.buffer);
  const sales = wb.getWorksheet("Sales")!;
  const summary = wb.getWorksheet("Summary")!;

  check("workbook · every sale says its business", sales.getRow(1).getCell(1).value, "Business");
  let diamondRows = 0;
  let badRows = 0;
  sales.eachRow((r, n) => {
    if (n === 1) return;
    const v = r.getCell(1).value;
    if (v === "Diamonds") diamondRows++;
    else if (v !== "Watches") badRows++;
  });
  const diamondLines = await prisma.salesRecord.count({
    where: { batchId: { in: await latestBatchIds(from, to) }, business: "DIAMOND" },
  });
  check("workbook · diamond rows are marked Diamonds", diamondRows, diamondLines);
  check("workbook · no row without a business", badRows, 0);

  const colA: { row: number; text: string }[] = [];
  summary.eachRow((r, n) => colA.push({ row: n, text: String(r.getCell(1).value ?? "") }));
  const find = (text: string) => colA.find((c) => c.text === text)?.row;
  const formula = (row: number, col: number) => {
    const v = summary.getRow(row).getCell(col).value as { formula?: string } | null;
    return v && typeof v === "object" && "formula" in v ? v.formula ?? "" : "";
  };

  const watchesTitle = find("Watches");
  const diamondsTitle = find("Diamonds");
  check("workbook · a Watches section", watchesTitle !== undefined, true);
  check("workbook · a separate Diamonds section", diamondsTitle !== undefined, all.diamond.units > 0);
  const allWatches = find("All watches")!;
  check("workbook · All watches counts watches only", formula(allWatches, 2).includes('"Watches"'), true);
  if (diamondsTitle) {
    const allDiamonds = find("All diamonds")!;
    check("workbook · All diamonds counts diamonds only", formula(allDiamonds, 2).includes('"Diamonds"'), true);
    check(
      "workbook · the diamonds header says pieces",
      summary.getRow(diamondsTitle + 1).getCell(2).value,
      "Pieces sold",
    );
    // Every show row in each section filters on its own business.
    const watchRows = colA.filter((c) => c.row > watchesTitle! + 1 && c.row < allWatches);
    check(
      "workbook · every watch show row filters on Watches",
      watchRows.every((c) => formula(c.row, 2).includes('"Watches"') && formula(c.row, 7).includes('"Watches"')),
      true,
    );
    const diamondRowsSummary = colA.filter((c) => c.row > diamondsTitle + 1 && c.row < allDiamonds);
    check(
      "workbook · every diamond show row filters on Diamonds",
      diamondRowsSummary.length > 0 &&
        diamondRowsSummary.every((c) => formula(c.row, 2).includes('"Diamonds"')),
      true,
    );
    check("workbook · a both-businesses row for the money", find("Watches and diamonds") !== undefined, true);
  }

  const commission = colA.find((c) => c.text.startsWith("Commission"))!.row;
  const commissionRows = colA.filter((c) => c.row > commission + 1 && c.text);
  check(
    "workbook · commission keeps the whole show name (TikTok AM, not TikTok)",
    commissionRows.every((c) => /\b(AM|PM)$/.test(c.text)),
    true,
  );
  check(
    "workbook · and the shift tag is a tag, not AM or PM",
    commissionRows.every((c) => !["AM", "PM"].includes(String(summary.getRow(c.row).getCell(2).value))),
    true,
  );
  check(
    "workbook · each commission line says its business",
    commissionRows.every((c) => ["Watches", "Diamonds"].includes(String(summary.getRow(c.row).getCell(3).value))),
    true,
  );
  // Every Sales reference in a Summary formula points at the column it means,
  // and every criteria pair is complete: the column letters all moved by one.
  const headerAt = (letter: string) => String(sales.getCell(`${letter}1`).value);
  const moneyHeaders = ["Unit Price", "Platform Discount", "Seller Discount", "Net Item Price", "Shipping", "Tax + Fees", "Order Total Collected"];
  const criteriaHeaders = ["Business", "Show", "Show Date", "Shift Tag", "Buyer"];
  let badRef = 0;
  let badArity = 0;
  summary.eachRow((r) =>
    r.eachCell((c) => {
      const f = (c.value as { formula?: string } | null)?.formula;
      if (!f) return;
      for (const m of f.matchAll(/(SUMIFS|COUNTIFS)\(([^()]*)\)/g)) {
        const args = m[2].split(",");
        const refs = [...m[2].matchAll(/Sales!\$([A-Z]+)\$2/g)].map((x) => x[1]);
        if (m[1] === "SUMIFS") {
          if (!moneyHeaders.includes(headerAt(refs[0]))) badRef++;
          if (args.length % 2 !== 1) badArity++;
          refs.slice(1).forEach((l) => { if (!criteriaHeaders.includes(headerAt(l))) badRef++; });
        } else {
          if (args.length % 2 !== 0) badArity++;
          refs.forEach((l) => { if (!criteriaHeaders.includes(headerAt(l))) badRef++; });
        }
      }
    }),
  );
  check("workbook · every Sales reference hits the right column", badRef, 0);
  check("workbook · every criteria pair is complete", badArity, 0);
  const allText: string[] = [];
  summary.eachRow((r) => r.eachCell((c) => { if (typeof c.value === "string") allText.push(c.value); }));
  check("workbook · no misspelled 'Watche' header", allText.some((t) => /\bWatche\b/.test(t)), false);
  check(
    "workbook · commission lists watches first",
    String(summary.getRow(commissionRows[0].row).getCell(3).value),
    "Watches",
  );

  if (from !== to) {
    const byDay = find("By day")!;
    const headers = (summary.getRow(byDay + 1).values as unknown[]).filter(Boolean);
    check(
      "workbook · By day keeps watches and pieces in their own columns",
      headers.includes("Watches sold") && (all.diamond.units === 0 || headers.includes("Pieces sold")),
      true,
    );
    check("workbook · By day says Watch net revenue", headers.includes("Watch net revenue"), true);
  }

  /* ------------------------------------ a day where every order was dropped */

  // A copy of one diamond report, moved to a day of its own with every order
  // cancelled: the upload has a batch but no sales rows.
  const source = [...firstFileOfDay.values()].flat().find((f) => f.text.includes("caratclublive"));
  if (source) {
    const rows = parseCsv(source.text.replace(/09\/27\/2026/g, "09/20/2026").replace(/09\/28\/2026/g, "09/21/2026"));
    const statusCol = rows[0].findIndex((h) => h.trim() === "Order Status");
    for (const r of rows.slice(1)) if (r.length > statusCol) r[statusCol] = "Canceled";
    const text = rows
      .map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
      .join("\r\n");
    const out = await runImport([{ name: "TESTCOPY-all-cancelled.csv", text }], boss.id);
    console.log(`\nAll-cancelled copy: ${out.status}, show day ${out.showDate}, ${out.watchCount} sold, ${out.droppedCount} dropped.`);
    if (out.status === "OK" && out.showDate) {
      const empty = await buildSalesWorkbook(out.showDate, out.showDate);
      const s = new ExcelJS.Workbook();
      await s.xlsx.load(empty!.buffer);
      const labels: string[] = [];
      s.getWorksheet("Summary")!.eachRow((r) => labels.push(String(r.getCell(1).value ?? "")));
      check("all-dropped day · the workbook still has a totals row", labels.includes("All watches"), true);
      const i = await getSalesInsights(out.showDate, out.showDate);
      check("all-dropped day · insights show nothing sold", i.totals.units + i.diamonds.units, 0);
    } else {
      check("all-dropped day · refused rather than half-loaded", out.status, "BLOCKED");
    }
  }
} finally {
  /* ---------------------------------------------------------------- cleanup */
  console.log("\nCleaning up.");
  const newBatches = (await prisma.importBatch.findMany({ select: { id: true } }))
    .map((b) => b.id)
    .filter((id) => !batchesBefore.has(id));
  const newPackages = (await prisma.package.findMany({ select: { id: true } }))
    .map((p) => p.id)
    .filter((id) => !packagesBefore.has(id));
  await prisma.scanEvent.deleteMany({ where: { packageId: { in: newPackages } } });
  await prisma.packageItem.deleteMany({ where: { packageId: { in: newPackages } } });
  await prisma.package.deleteMany({ where: { id: { in: newPackages } } });
  await prisma.importBatch.deleteMany({ where: { id: { in: newBatches } } });
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Builds the sales workbook from a real day and checks it is what the CFO
 * already reads.
 *
 * The format matters as much as the figures here: this is the shape of the
 * workbook produced by hand from the master specification, and it was signed
 * off in that shape.
 *
 *   STREAMOPS_IMPORT_FIXTURES=<folder with one day's three exports> \
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-workbook.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "../src/lib/db";
import { runImport } from "../src/lib/server/imports";
import { buildSalesWorkbook } from "../src/lib/server/sales-workbook";

assertDevDatabase("check-workbook.mts");

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

const boss = await prisma.user.findFirst({ where: { isActive: true }, select: { id: true } });
if (!boss) {
  console.log("SKIP  need an account to attribute the upload to. Run the seed first.");
  process.exit(0);
}

const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith(".csv"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

const first = await runImport(files, boss.id);
const day = first.showDate!;
const showDate = new Date(`${day}T00:00:00.000Z`);
console.log(`Imported ${first.watchCount} watches for ${day}.\n`);

// Upload the same day a second time. Every upload keeps its own sales rows, so
// this is what proves the workbook reads the latest and not all of them.
await runImport(files, boss.id);
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

const built = await buildSalesWorkbook(day, day);
check("a workbook was produced", built !== null, true);
check("named for the show day", built?.filename, `BO_Retail_Show_Sales_${day}.xlsx`);
check("counting the day once, not twice", built?.rows, 473);

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(built!.buffer);

// Summary first, the way the workbook has always opened.
check("three sheets, in that order", wb.worksheets.map((s) => s.name), ["Summary", "Sales", "Exceptions"]);

const sales = wb.getWorksheet("Sales")!;
const summary = wb.getWorksheet("Summary")!;
const exceptions = wb.getWorksheet("Exceptions")!;

/* ------------------------------------------------------------ the Sales sheet */

check("473 watches plus a header", sales.rowCount, 474);
check(
  "the columns the earlier workbook had",
  (sales.getRow(1).values as unknown[]).slice(1, 6),
  ["Platform", "Show", "Show Date", "Shift Tag", "Order Ref"],
);
check("frozen below the header", sales.views[0]?.ySplit, 1);
check("and filtered", sales.autoFilter !== undefined, true);
check("money is formatted as money", sales.getColumn(14).numFmt, '$#,##0.00;($#,##0.00);-');
check("in Arial", sales.getRow(2).getCell(1).font?.name, "Arial");

/* ---------------------------------------------------------- the Summary sheet */

const formulaAt = (address: string) => {
  const cell = summary.getCell(address);
  return typeof cell.value === "object" && cell.value !== null && "formula" in cell.value
    ? (cell.value as { formula: string }).formula
    : null;
};

check("watches sold is a formula, not a pasted number", formulaAt("B4")?.startsWith("COUNTIFS"), true);
check("net revenue is a formula", formulaAt("G4")?.startsWith("SUMIFS"), true);

// The earlier workbook rendered "87.000000000000043 buyers". Same formula,
// rounded to what it is already counting.
const buyers = formulaAt("C4");
check("distinct buyers still uses SUMPRODUCT", buyers?.includes("SUMPRODUCT"), true);
check("but rounded, so it cannot render as 87.000000000000043", buyers?.startsWith("ROUND("), true);

const showNames = [4, 5, 6].map((r) => summary.getCell(`A${r}`).value);
check("one row per show", showNames, ["TikTok AM", "TikTok PM", "eBay PM"].sort());
check("then an All shows row", summary.getCell("A7").value, "All shows");
check("which sums the sheet rather than the rows above", formulaAt("G7")?.startsWith("SUM("), true);

const text = (row: number) => String(summary.getCell(`A${row}`).value ?? "");
const commissionRow = [...Array(40).keys()]
  .map((i) => i + 8)
  .find((r) => text(r).startsWith("Commission"));
check("a commission table exists", commissionRow !== undefined, true);
check(
  "it keeps the shift tag beside the show",
  summary.getCell(`B${commissionRow! + 1}`).value,
  "Shift tag on item",
);

// Pay follows the show a watch sold in, not the tag on the listing. This
// heading said the opposite, which would have had somebody reconciling a
// payroll run against the wrong column.
check(
  "and says the Show column is who is paid",
  text(commissionRow!).includes("Show column is who is paid"),
  true,
);
check(
  "not the shift tag",
  text(commissionRow!).includes("Shift tag says who is paid"),
  false,
);

/* ------------------------------------------------------- the Exceptions sheet */

check("every dropped row is listed", exceptions.rowCount, 18); // 17 + header
const reasons = new Set<string>();
exceptions.eachRow((r, i) => {
  if (i > 1) reasons.add(String(r.getCell(6).value ?? "").split(":")[0]);
});
check("with the cancelled orders", [...reasons].some((r) => r.startsWith("Canceled")), true);
check("the never-paid ones", reasons.has("committed but never paid"), true);
check(
  "and the eBay summary row",
  [...reasons].some((r) => r.includes("summary row")),
  true,
);

/* ----------------------------------------------------------------- a range */

const ranged = await buildSalesWorkbook(day, day);
check("a range is named for both ends when they differ", (await buildSalesWorkbook("2026-09-01", day))?.filename, `BO_Retail_Show_Sales_2026-09-01_to_${day}.xlsx`);
check("a day with nothing loaded produces nothing", await buildSalesWorkbook("2000-01-01", "2000-01-01"), null);
check("the single-day build is repeatable", ranged?.rows, 473);

// Leave a copy outside the repo so the format can be eyeballed without a
// generated file turning up in `git status`.
const out = join(process.env.TEMP ?? process.env.TMPDIR ?? ".", `BO_Retail_Show_Sales_${day}.xlsx`);
writeFileSync(out, Buffer.from(built!.buffer));
console.log(`\nWrote ${out} for inspection.`);

/* ------------------------------------------------------------------ cleanup */

console.log("Cleaning up.");
await prisma.scanEvent.deleteMany({ where: { package: { showDate } } });
await prisma.packageItem.deleteMany({ where: { package: { showDate } } });
await prisma.package.deleteMany({ where: { showDate } });
await prisma.importBatch.deleteMany({ where: { showDate } });

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll workbook checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

import "server-only";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { fromDbDate } from "@/lib/domain/dates";
import type { DateISO } from "@/lib/domain/types";
import { latestBatchIds } from "./sales-data";

/**
 * A show day's sales as a workbook — the shape the manual run produced, which
 * is the one that has already been read and trusted.
 *
 * Three sheets: Summary, Sales, Exceptions. Arial. Currency as
 * `$#,##0.00;($#,##0.00);-`. Sales frozen below its header and filtered.
 *
 * Every figure on Summary is a **live formula** over Sales rather than a pasted
 * value, so correcting a row recalculates the totals instead of leaving them
 * contradicting the rows underneath them.
 *
 * One day by default; `?from=&to=` gives a range, which adds a per-day table
 * beneath the main one — over a fortnight "which day was that" is the first
 * question anybody asks.
 *
 * Watches and diamonds are summed apart, never together. Both sell a "TikTok
 * AM", so grouping by show name alone put a diamond show and a watch show on
 * one row, and counted diamond pieces as watches. Every row on Sales says its
 * business, and every figure on Summary filters on it.
 */

const BRAND = "FF3F49B8";
const MONEY = '$#,##0.00;($#,##0.00);-';

/** Sales sheet columns, in the order the earlier workbook used. */
const SALES_COLUMNS: { header: string; width: number; money?: boolean }[] = [
  { header: "Business", width: 10 },
  { header: "Platform", width: 10 },
  { header: "Show", width: 12 },
  { header: "Show Date", width: 12 },
  { header: "Shift Tag", width: 14 },
  { header: "Order Ref", width: 22 },
  { header: "Line Ref", width: 22 },
  { header: "Buyer", width: 20 },
  { header: "Model", width: 16 },
  { header: "Category", width: 16 },
  { header: "Qty", width: 6 },
  { header: "Unit Price", width: 12, money: true },
  { header: "Platform Discount", width: 16, money: true },
  { header: "Seller Discount", width: 14, money: true },
  { header: "Net Item Price", width: 14, money: true },
  { header: "Shipping", width: 12, money: true },
  { header: "Tax + Fees", width: 12, money: true },
  { header: "Order Total Collected", width: 20, money: true },
  { header: "Created (Pacific)", width: 20 },
  { header: "Created (Eastern)", width: 20 },
  { header: "Paid On", width: 12 },
  { header: "State", width: 16 },
  { header: "Payment Method", width: 18 },
  { header: "Package ID", width: 22 },
  { header: "Tracking", width: 24 },
  { header: "Source File", width: 34 },
];

/** Column letters on Sales, so the Summary formulas read as they did before. */
const COL = {
  business: "A",
  show: "C",
  buyer: "H",
  unitPrice: "L",
  platformDiscount: "M",
  sellerDiscount: "N",
  net: "O",
  shipping: "P",
  tax: "Q",
  total: "R",
  showDate: "D",
  shiftTag: "E",
} as const;

/** What the Business column says, and what one thing sold is called. */
const BUSINESS_NAME = { WATCH: "Watches", DIAMOND: "Diamonds" } as const;
const SOLD_HEADER = { WATCH: "Watches sold", DIAMOND: "Pieces sold" } as const;
const NET_HEADER = { WATCH: "Watch net revenue", DIAMOND: "Diamond net revenue" } as const;
type BusinessKey = keyof typeof BUSINESS_NAME;

function styleHeader(row: ExcelJS.Row) {
  row.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
  row.alignment = { vertical: "middle" };
  row.height = 22;
}

const cents = (n: number) => Math.round(n) / 100;

export interface SalesWorkbook {
  buffer: ArrayBuffer;
  filename: string;
  /** How many paid sales rows went into it, watches and diamonds. */
  rows: number;
}

/**
 * Builds the workbook for a date range, or returns null when nothing has been
 * loaded for it.
 *
 * Separated from the route so it can be exercised against a real database
 * without a request — the same reason `runImport` and the packing flow take a
 * user id rather than reading a session.
 */
export async function buildSalesWorkbook(
  from: DateISO,
  to: DateISO,
): Promise<SalesWorkbook | null> {

  // Only the most recent successful upload for each day — see `sales-data`.
  const batchIds = await latestBatchIds(from, to);

  if (batchIds.length === 0) return null;

  const [sales, drops] = await Promise.all([
    prisma.salesRecord.findMany({
      where: { batchId: { in: batchIds } },
      orderBy: [{ showDate: "asc" }, { show: "asc" }, { orderRef: "asc" }],
    }),
    prisma.importDrop.findMany({
      where: { batchId: { in: batchIds } },
      orderBy: [{ platform: "asc" }, { orderRef: "asc" }],
    }),
  ]);

  const wb = new ExcelJS.Workbook();
  wb.creator = "StreamOps";
  wb.created = new Date();

  // Summary is created first so it is the first tab, which is the order the
  // workbook has always opened in — but it is filled in last, because every
  // formula on it points at Sales and needs to know how many rows are there.
  const summary = wb.addWorksheet("Summary");

  /* ------------------------------------------------------- sheet 2: sales */

  const salesSheet = wb.addWorksheet("Sales", { views: [{ state: "frozen", ySplit: 1 }] });
  salesSheet.columns = SALES_COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  styleHeader(salesSheet.getRow(1));

  const easternFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "short",
    timeStyle: "medium",
  });
  const pacificFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "short",
    timeStyle: "medium",
  });

  for (const s of sales) {
    salesSheet.addRow([
      BUSINESS_NAME[s.business],
      s.platform === "TIKTOK" ? "TikTok" : "eBay",
      s.show,
      fromDbDate(s.showDate),
      s.shiftTag,
      s.orderRef,
      s.lineRef,
      s.buyer,
      s.stockNumber,
      s.category,
      s.qty,
      cents(s.unitPriceCents),
      cents(s.platformDiscountCents),
      cents(s.sellerDiscountCents),
      cents(s.netItemPriceCents),
      cents(s.shippingCents),
      cents(s.taxAndFeesCents),
      cents(s.orderTotalCents),
      s.soldAt ? pacificFmt.format(s.soldAt) : "",
      s.soldAt ? easternFmt.format(s.soldAt) : "",
      s.paidOn ? fromDbDate(s.paidOn) : "",
      s.state,
      s.paymentMethod,
      s.sourcePackageId,
      s.tracking,
      s.sourceFile,
    ]);
  }

  const lastRow = Math.max(2, sales.length + 1);
  SALES_COLUMNS.forEach((c, i) => {
    if (!c.money) return;
    salesSheet.getColumn(i + 1).numFmt = MONEY;
  });
  salesSheet.autoFilter = { from: "A1", to: { row: lastRow, column: SALES_COLUMNS.length } };
  salesSheet.getColumn(1).font = { name: "Arial", size: 10 };

  /** `Sales!$N$2:$N$474` — an absolute column range over the data rows. */
  const range$ = (col: string) => `Sales!$${col}$2:$${col}$${lastRow}`;

  /* ----------------------------------------------------- sheet 1: summary */

  summary.getColumn(1).width = 22;
  for (let c = 2; c <= 10; c++) summary.getColumn(c).width = 18;

  summary.mergeCells("A1:J1");
  const title = summary.getCell("A1");
  title.value = from === to ? `BO Retail — Show Sales, ${from}` : `BO Retail — Show Sales, ${from} to ${to}`;
  title.font = { name: "Arial", bold: true, size: 14 };
  summary.getRow(1).height = 26;

  summary.mergeCells("A2:J2");
  summary.getCell("A2").value =
    "Paid orders only — unpaid and cancelled orders removed (see Exceptions). Every figure is a formula over the Sales sheet.";
  summary.getCell("A2").font = { name: "Arial", italic: true, size: 10, color: { argb: "FF5B6472" } };

  const MONEY_SUMS: [string, string][] = [
    ["D", COL.unitPrice],
    ["E", COL.platformDiscount],
    ["F", COL.sellerDiscount],
    ["G", COL.net],
    ["H", COL.shipping],
    ["I", COL.tax],
    ["J", COL.total],
  ];
  const MONEY_HEADERS = [
    "Gross list price",
    "Platform discount",
    "Seller discount",
    "Net product revenue",
    "Shipping charged",
    "Tax & fees collected",
    "Total collected from buyers",
  ];

  /** A criteria pair for one business, for COUNTIFS and SUMIFS. */
  const isBusiness = (b: BusinessKey) => `${range$(COL.business)},"${BUSINESS_NAME[b]}"`;

  /**
   * Distinct buyers, as a formula.
   *
   * The earlier workbook used the same SUMPRODUCT, which accumulates floating
   * point error and renders as `87.000000000000043 buyers`. The formula is the
   * right shape; it just needs rounding to what it is already counting. The
   * conditions pick the rows to count; each buyer then counts once within them.
   */
  const distinctBuyers = (conditions: { col: string; equals: string }[]) => {
    const test = conditions.map((c) => `(${range$(c.col)}=${c.equals})`).join("*");
    const same = conditions.map((c) => `${range$(c.col)},${range$(c.col)}&""`).join(",");
    return `ROUND(SUMPRODUCT(${test ? test + "*" : ""}(${range$(COL.buyer)}<>"")/COUNTIFS(${same}${same ? "," : ""}${range$(COL.buyer)},${range$(COL.buyer)}&"")),0)`;
  };

  // A day whose every order was dropped still gets a watch section of zeros,
  // as it always did, rather than a Summary with nothing on it.
  const present = (["WATCH", "DIAMOND"] as const).filter((b) => sales.some((s) => s.business === b));
  const businesses: BusinessKey[] = present.length > 0 ? [...present] : ["WATCH"];

  let row = 3;
  for (const b of businesses) {
    const name = BUSINESS_NAME[b];
    summary.getCell(`A${row}`).value = name;
    summary.getCell(`A${row}`).font = { name: "Arial", bold: true, size: 12 };
    row++;
    summary.getRow(row).values = ["Show", SOLD_HEADER[b], "Distinct buyers", ...MONEY_HEADERS];
    styleHeader(summary.getRow(row));
    row++;

    const shows = [...new Set(sales.filter((s) => s.business === b).map((s) => s.show))].sort();
    for (const show of shows) {
      const r = row;
      summary.getCell(`A${r}`).value = show;
      summary.getCell(`B${r}`).value = { formula: `COUNTIFS(${isBusiness(b)},${range$(COL.show)},$A${r})` };
      summary.getCell(`C${r}`).value = {
        formula: distinctBuyers([
          { col: COL.business, equals: `"${name}"` },
          { col: COL.show, equals: `$A${r}` },
        ]),
      };
      for (const [target, source] of MONEY_SUMS) {
        summary.getCell(`${target}${r}`).value = {
          formula: `SUMIFS(${range$(source)},${isBusiness(b)},${range$(COL.show)},$A${r})`,
        };
        summary.getCell(`${target}${r}`).numFmt = MONEY;
      }
      row++;
    }

    // Summed straight off the Sales sheet rather than off the rows above, so a
    // show that somehow never made it into the list cannot be lost. Distinct
    // people, not the sum of the rows above: that counted anybody who bought
    // in two shows twice (235 against 219 real people on 09/08).
    const totalRow = row;
    summary.getCell(`A${totalRow}`).value = `All ${name.toLowerCase()}`;
    summary.getCell(`B${totalRow}`).value = { formula: `COUNTIFS(${isBusiness(b)})` };
    summary.getCell(`C${totalRow}`).value = {
      formula: distinctBuyers([{ col: COL.business, equals: `"${name}"` }]),
    };
    for (const [target, source] of MONEY_SUMS) {
      summary.getCell(`${target}${totalRow}`).value = { formula: `SUMIFS(${range$(source)},${isBusiness(b)})` };
      summary.getCell(`${target}${totalRow}`).numFmt = MONEY;
    }
    summary.getRow(totalRow).font = { name: "Arial", bold: true };
    row = totalRow + 2;
  }

  // Money can be added across the two businesses; watches and pieces cannot,
  // so the together row carries money and people only.
  if (businesses.length > 1) {
    summary.getCell(`A${row}`).value = "Both businesses together";
    summary.getCell(`A${row}`).font = { name: "Arial", bold: true, size: 12 };
    row++;
    summary.getRow(row).values = ["", "", "Distinct buyers", ...MONEY_HEADERS];
    styleHeader(summary.getRow(row));
    row++;
    summary.getCell(`A${row}`).value = "Watches and diamonds";
    summary.getCell(`B${row}`).value = "not added";
    summary.getCell(`C${row}`).value = { formula: distinctBuyers([]) };
    for (const [target, source] of MONEY_SUMS) {
      summary.getCell(`${target}${row}`).value = { formula: `SUM(${range$(source)})` };
      summary.getCell(`${target}${row}`).numFmt = MONEY;
    }
    summary.getRow(row).font = { name: "Arial", bold: true };
    row += 2;
  }

  /* ------------------------------------------------- per day, for a range */

  if (from !== to) {
    const days = [...new Set(sales.map((s) => fromDbDate(s.showDate)))].sort();
    summary.getCell(`A${row}`).value = "By day";
    summary.getCell(`A${row}`).font = { name: "Arial", bold: true, size: 12 };
    row++;
    const headers = ["Show day"];
    for (const b of businesses) headers.push(SOLD_HEADER[b], NET_HEADER[b]);
    headers.push("Total collected");
    summary.getRow(row).values = headers;
    styleHeader(summary.getRow(row));
    row++;
    for (const day of days) {
      summary.getCell(`A${row}`).value = day;
      let col = 2;
      for (const b of businesses) {
        const count = summary.getCell(row, col++);
        count.value = { formula: `COUNTIFS(${isBusiness(b)},${range$(COL.showDate)},$A${row})` };
        const net = summary.getCell(row, col++);
        net.value = { formula: `SUMIFS(${range$(COL.net)},${isBusiness(b)},${range$(COL.showDate)},$A${row})` };
        net.numFmt = MONEY;
      }
      const total = summary.getCell(row, col);
      total.value = { formula: `SUMIFS(${range$(COL.total)},${range$(COL.showDate)},$A${row})` };
      total.numFmt = MONEY;
      row++;
    }
    row++;
  }

  /* ------------------------------------------------------ commission split */

  // The Show column is what pay is worked out on. The shift tag is kept beside
  // it because it is the only way to see a listing that was prepared for one
  // show and bought during another — useful for spotting a mis-tagged listing,
  // and on eBay it is what decides the Show column in the first place.
  summary.getCell(`A${row}`).value =
    "Commission — the Show column is who is paid; the Shift tag is which show the item was listed for";
  summary.getCell(`A${row}`).font = { name: "Arial", bold: true, size: 12 };
  row++;
  summary.getRow(row).values = ["Show", "Shift tag on item", "Business", "Sold", "Net product revenue"];
  styleHeader(summary.getRow(row));
  row++;

  // Kept as three parts, never joined into one string and split again: show
  // names have spaces in them ("TikTok AM"), and splitting on a space used to
  // put "AM" in the shift tag column and zero in every count.
  const groups = new Map<string, { show: string; tag: string; business: BusinessKey }>();
  for (const s of sales) {
    groups.set(JSON.stringify([s.business, s.show, s.shiftTag]), { show: s.show, tag: s.shiftTag, business: s.business });
  }
  // Watches first, as on the rest of Summary.
  const rank = { WATCH: 0, DIAMOND: 1 } as const;
  const ordered = [...groups.values()].sort(
    (a, b) => rank[a.business] - rank[b.business] || a.show.localeCompare(b.show) || a.tag.localeCompare(b.tag),
  );
  for (const g of ordered) {
    summary.getCell(`A${row}`).value = g.show;
    summary.getCell(`B${row}`).value = g.tag;
    summary.getCell(`C${row}`).value = BUSINESS_NAME[g.business];
    summary.getCell(`D${row}`).value = {
      formula: `COUNTIFS(${range$(COL.business)},$C${row},${range$(COL.show)},$A${row},${range$(COL.shiftTag)},$B${row})`,
    };
    summary.getCell(`E${row}`).value = {
      formula: `SUMIFS(${range$(COL.net)},${range$(COL.business)},$C${row},${range$(COL.show)},$A${row},${range$(COL.shiftTag)},$B${row})`,
    };
    summary.getCell(`E${row}`).numFmt = MONEY;
    row++;
  }

  /* -------------------------------------------------- sheet 3: exceptions */

  const exceptions = wb.addWorksheet("Exceptions", { views: [{ state: "frozen", ySplit: 1 }] });
  exceptions.columns = [
    { header: "Platform", width: 10 },
    { header: "Order Ref", width: 22 },
    { header: "Buyer", width: 20 },
    { header: "Model", width: 16 },
    { header: "Amount on the row", width: 18 },
    { header: "Why it was not counted", width: 62 },
    { header: "Source File", width: 34 },
  ];
  styleHeader(exceptions.getRow(1));

  for (const d of drops) {
    exceptions.addRow([
      d.platform === "TIKTOK" ? "TikTok" : "eBay",
      d.orderRef,
      d.buyer,
      d.stockNumber,
      cents(d.amountCents),
      d.reason,
      d.sourceFile,
    ]);
  }
  exceptions.getColumn(5).numFmt = MONEY;
  if (drops.length > 0) {
    exceptions.autoFilter = { from: "A1", to: { row: drops.length + 1, column: 7 } };
  }

  // Arial throughout, without losing the bold and white already set on headers.
  for (const sheet of [summary, salesSheet, exceptions]) {
    sheet.eachRow((r) =>
      r.eachCell((cell) => {
        cell.font = { ...(cell.font ?? {}), name: "Arial" };
      }),
    );
  }

  const filename =
    from === to
      ? `BO_Retail_Show_Sales_${from}.xlsx`
      : `BO_Retail_Show_Sales_${from}_to_${to}.xlsx`;

  const buffer = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  return { buffer, filename, rows: sales.length };
}

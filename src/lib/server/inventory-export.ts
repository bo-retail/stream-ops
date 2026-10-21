import "server-only";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { addDays, formatDate, fromDbDate, isDateISO, toDbDate } from "@/lib/domain/dates";
import { COUNTED_LABEL, COUNTED_PLACES, soldByShow } from "@/lib/domain/inventory";
import type { CountedPlace, SoldAtShow } from "@/lib/domain/inventory";
import type { DateISO } from "@/lib/domain/types";
import { bringStockUpToDateQuietly, getStartDate } from "./deduction";
import type { StockUpToDate } from "./deduction";
import { listStock } from "./inventory";
import { receiptsBetween } from "./receive";
import { returnsBetween } from "./returns";

/**
 * Inventory as an Excel file (Samuel, 10/14: "download excel of inventory —
 * which days subtracted what units, all of that").
 *
 *   Stock now        every model: the four places, the total, and how many
 *                    have been sold since the start day
 *   By day           each show day and show: how many came off, from where
 *   Sales subtracted every watch taken off, one row each: when, which show,
 *                    the order, what it sold as, the model, the place, and
 *                    whether it has shipped
 *   Received         every shipment received: day, model, place, pieces
 *   Not taken off    sold, but nothing to take it off from
 */

const PLACE_NAME: Record<string, string> = { ...COUNTED_LABEL, DAMAGED: "Damaged" };
const isCounted = (p: string): p is CountedPlace => (COUNTED_PLACES as readonly string[]).includes(p);

function header(row: ExcelJS.Row) {
  row.font = { bold: true };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF1F5" } };
}

function titled(wb: ExcelJS.Workbook, name: string, title: string, columns: { header: string; width: number }[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 2 }] });
  ws.getCell("A1").value = title;
  ws.getCell("A1").font = { italic: true, color: { argb: "FF5B6472" } };
  ws.getRow(2).values = columns.map((c) => c.header);
  header(ws.getRow(2));
  columns.forEach((c, i) => (ws.getColumn(i + 1).width = c.width));
  return ws;
}

/** How far back a range starts when none is picked: a month, so the page and the file stay quick. */
export const DEFAULT_RANGE_DAYS = 30;

/** The most "Sales subtracted" rows one file holds, so it always downloads. */
export const MAX_SALE_ROWS = 60_000;

/**
 * The range a page or file asks about: show days from and to, never before
 * the start day (nothing came off before it) and never after today. Missing
 * or unreadable ends are the last month and today.
 */
export function rangeOf(start: DateISO | null, today: DateISO, from?: string, to?: string): { from: DateISO; to: DateISO } {
  const floor = start ?? today;
  const monthAgo = addDays(today, -DEFAULT_RANGE_DAYS);
  let f = from && isDateISO(from) ? from : floor > monthAgo ? floor : monthAgo;
  let t = to && isDateISO(to) ? to : today;
  if (f < floor) f = floor;
  if (t > today) t = today;
  if (f > t) f = t;
  if (f < floor) f = floor;
  if (t < f) t = f;
  return { from: f, to: t };
}

/**
 * The show days a range really reads. A range that reaches today reaches
 * tomorrow too: a night show running past midnight is dated tomorrow, and
 * its sales come off stock today (the deduction reads a day ahead the same way).
 */
function readTo(to: DateISO, today: DateISO): DateISO {
  return to >= today ? addDays(today, 1) : to;
}

/** Every watch taken off between two show days, oldest first — at most `limit`. */
export async function salesBetween(from: DateISO, to: DateISO, today: DateISO, limit?: number) {
  return prisma.stockSale.findMany({
    where: { status: { in: ["SOLD", "SENT"] }, showDate: { gte: toDbDate(from), lte: toDbDate(readTo(to, today)) } },
    ...(limit ? { take: limit } : {}),
    orderBy: [{ showDate: "asc" }, { show: "asc" }, { orderRef: "asc" }],
    select: {
      showDate: true, show: true, platform: true, orderRef: true, listing: true, place: true,
      status: true, sentAt: true, tracking: true, flag: true, product: { select: { model: true } },
    },
  });
}

/** How many of each model came off between two show days — counted by the database. */
export async function soldByModel(from: DateISO, to: DateISO, today: DateISO): Promise<Map<string, number>> {
  const counts = await prisma.stockSale.groupBy({
    by: ["productId"],
    where: { status: { in: ["SOLD", "SENT"] }, showDate: { gte: toDbDate(from), lte: toDbDate(readTo(to, today)) } },
    _count: { _all: true },
  });
  if (counts.length === 0) return new Map();
  const products = await prisma.product.findMany({ where: { id: { in: counts.map((c) => c.productId) } }, select: { id: true, model: true } });
  const modelOf = new Map(products.map((p) => [p.id, p.model]));
  return new Map(counts.map((c) => [modelOf.get(c.productId) ?? c.productId, c._count._all]));
}

/**
 * When one model sold, show by show, since the start day — read from the
 * same record of watches taken off stock as the Sold column and the counts,
 * so the three always agree. A corrected upload has already replaced the old
 * one's sales there, and a random pull counts as the watch it turned out to be.
 *
 * Brought up to date first (only if anything changed): an upload made while
 * the page was open shows the moment the row is opened.
 */
export async function modelSoldByShow(model: string, actorId: string | null): Promise<SoldAtShow[]> {
  await bringStockUpToDateQuietly(actorId, { ifChanged: true });
  const start = await getStartDate();
  if (!start) return [];
  const sales = await prisma.stockSale.findMany({
    where: { product: { model }, status: { in: ["SOLD", "SENT"] }, showDate: { gte: toDbDate(start) } },
    select: { showDate: true, show: true },
  });
  return soldByShow(sales.map((s) => ({ day: fromDbDate(s.showDate), show: s.show })));
}

export async function inventoryWorkbook(
  range: { from: DateISO; to: DateISO },
  today: DateISO,
  run: StockUpToDate | null,
  timezone: string,
): Promise<ArrayBuffer> {
  const [stock, sales] = await Promise.all([listStock(), salesBetween(range.from, range.to, today, MAX_SALE_ROWS + 1)]);
  const cut = sales.length > MAX_SALE_ROWS;
  if (cut) sales.length = MAX_SALE_ROWS;
  const shipDay = (d: Date) => d.toLocaleDateString("en-US", { timeZone: timezone });
  const since =
    range.from === range.to ? `on ${formatDate(range.from)}` : `from ${formatDate(range.from)} to ${formatDate(range.to)}`;
  const inRange = (day: DateISO) => day >= range.from && day <= readTo(range.to, today);
  const wb = new ExcelJS.Workbook();

  /* ------------------------------------------------------------ stock now */
  const soldOf = new Map<string, number>();
  for (const s of sales) soldOf.set(s.product.model, (soldOf.get(s.product.model) ?? 0) + 1);
  const now = titled(wb, "Stock now", `Inventory as it is on ${formatDate(today)}. Sold in range = taken off ${since}.`, [
    { header: "Model", width: 14 },
    { header: "Description", width: 48 },
    ...COUNTED_PLACES.map((p) => ({ header: COUNTED_LABEL[p], width: 13 })),
    { header: "Total now", width: 11 },
    { header: "Sold in range", width: 13 },
  ]);
  now.getColumn(1).numFmt = "@";
  for (const r of stock) {
    const total = COUNTED_PLACES.reduce((n, p) => n + r.balances[p], 0);
    const sold = soldOf.get(r.model) ?? 0;
    if (total === 0 && sold === 0 && COUNTED_PLACES.every((p) => r.balances[p] === 0)) continue;
    now.addRow([r.model, r.description, ...COUNTED_PLACES.map((p) => r.balances[p]), total, sold]);
  }

  /* --------------------------------------------------------------- by day */
  const byDay = titled(wb, "By day", `Watches taken off ${since}, by show day and show.`, [
    { header: "Show day", width: 14 },
    { header: "Show", width: 18 },
    { header: "Units", width: 10 },
    ...COUNTED_PLACES.map((p) => ({ header: `From ${COUNTED_LABEL[p]}`, width: 16 })),
  ]);
  const days = new Map<string, { day: DateISO; show: string; units: number; from: Record<string, number> }>();
  for (const s of sales) {
    const day = fromDbDate(s.showDate);
    const key = `${day}|${s.show}`;
    const d = days.get(key) ?? { day, show: s.show, units: 0, from: {} };
    d.units += 1;
    d.from[s.place] = (d.from[s.place] ?? 0) + 1;
    days.set(key, d);
  }
  for (const d of days.values()) {
    byDay.addRow([formatDate(d.day), d.show, d.units, ...COUNTED_PLACES.map((p) => d.from[p] ?? 0)]);
  }
  if (days.size > 0) {
    const totals = byDay.addRow([
      "Total", "", sales.length,
      ...COUNTED_PLACES.map((p) => sales.filter((s) => s.place === p).length),
    ]);
    totals.font = { bold: true };
  }

  /* ------------------------------------------------------ sales subtracted */
  const list = titled(
    wb,
    "Sales subtracted",
    cut
      ? `The first ${MAX_SALE_ROWS.toLocaleString("en-US")} watches taken off ${since} — pick a shorter range for the rest. "Stock now" and "By day" count them all only up to here.`
      : `Every watch taken off ${since}, one row each.`,
    [
    { header: "Show day", width: 14 },
    { header: "Show", width: 18 },
    { header: "Platform", width: 10 },
    { header: "Order", width: 22 },
    { header: "Sold as", width: 22 },
    { header: "Model", width: 14 },
    { header: "Taken from", width: 14 },
    { header: "Shipped", width: 22 },
      { header: "Note", width: 50 },
    ],
  );
  for (const s of sales) {
    list.addRow([
      formatDate(fromDbDate(s.showDate)),
      s.show,
      s.platform === "EBAY" ? "eBay" : "TikTok",
      s.orderRef,
      s.listing,
      s.product.model,
      isCounted(s.place) ? COUNTED_LABEL[s.place] : (PLACE_NAME[s.place] ?? s.place),
      s.status === "SENT" ? (s.sentAt ? `Yes, ${shipDay(s.sentAt)}` : "Yes") : "Waiting to ship",
      s.flag,
    ]);
  }

  /* --------------------------------------------------------------- received */
  const received = titled(wb, "Received", `Inventory received ${since}, by the day it arrived.`, [
    { header: "Received on", width: 14 },
    { header: "Model", width: 14 },
    { header: "Place", width: 14 },
    { header: "Pieces", width: 10 },
    { header: "Delivery", width: 50 },
  ]);
  received.getColumn(2).numFmt = "@";
  for (const r of await receiptsBetween(range.from, range.to)) {
    received.addRow([
      formatDate(r.receivedOn),
      r.product.model,
      isCounted(r.place) ? COUNTED_LABEL[r.place] : (PLACE_NAME[r.place] ?? r.place),
      r.qty,
      r.note.replace(/^Received \S+ — /, ""),
    ]);
  }

  /* --------------------------------------------------------------- returned */
  const returned = titled(wb, "Returned", `Returns added back to inventory ${since}, by the day they came back.`, [
    { header: "Came back on", width: 14 },
    { header: "Model", width: 14 },
    { header: "Place", width: 14 },
    { header: "Pieces", width: 10 },
    { header: "Returns", width: 50 },
  ]);
  returned.getColumn(2).numFmt = "@";
  for (const r of await returnsBetween(range.from, range.to)) {
    returned.addRow([
      formatDate(r.returnedOn),
      r.product.model,
      isCounted(r.place) ? COUNTED_LABEL[r.place] : (PLACE_NAME[r.place] ?? r.place),
      r.qty,
      r.note.replace(/^Returned \S+ — /, ""),
    ]);
  }

  /* ---------------------------------------------------------- not taken off */
  const missed = titled(
    wb,
    "Not taken off",
    run === null
      ? "Could not be checked: stock could not be brought up to date just now. Download again in a minute."
      : "Sold in the last 14 days (within the range) but nothing to take it off from. Add the model on the next count if it is ours.",
    [
    { header: "Show day", width: 14 },
    { header: "Show", width: 18 },
    { header: "Order", width: 22 },
    { header: "Sold as", width: 22 },
      { header: "Why", width: 60 },
    ],
  );
  for (const w of (run?.unknown ?? []).filter((w) => inRange(w.line.showDate))) {
    missed.addRow([formatDate(w.line.showDate), w.line.show, w.line.orderRef, w.line.stockNumber, "That model is not in inventory."]);
  }
  for (const w of (run?.unnamed ?? []).filter((w) => inRange(w.line.showDate))) {
    missed.addRow([
      formatDate(w.line.showDate), w.line.show, w.line.orderRef, w.line.stockNumber,
      "A random pull with no model number yet — it comes off once the report names it, or it is scanned when packed.",
    ]);
  }

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

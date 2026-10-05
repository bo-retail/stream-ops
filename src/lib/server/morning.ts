import "server-only";
import { prisma } from "@/lib/db";
import { addDays, datesBetween, fromDbDate, toDbDate } from "@/lib/domain/dates";
import { emptyFigures, morningFigures, type DayFigures, type MorningLine, type SoldUnit } from "@/lib/domain/morning";
import type { DateISO } from "@/lib/domain/types";
import { getStartDate } from "./deduction";
import { latestBatchIds } from "./sales-data";
import { missingReportsOn } from "./show-plan";

export interface MorningDay extends DayFigures {
  date: DateISO;
}

export interface MorningNumbers {
  /** The show day asked for. */
  day: MorningDay;
  /** The seven show days up to and including it, oldest first. */
  week: MorningDay[];
  /** That day's shows whose report is not uploaded yet. */
  missingReports: string[];
  /** The first show day whose sales came off stock with a cost snapshot. */
  startDate: DateISO | null;
}

/**
 * How far either side of the week the reports are read, so an order whose
 * latest upload is on another day (an eBay order paid across two days) is
 * read from that upload, as stock deduction reads it.
 */
const MARGIN_DAYS = 14;

/**
 * The morning numbers for a show day, and the six before it.
 *
 * Watch sales from the current uploads, worked into units the way stock
 * deduction does, each costed at the snapshot taken when it came off stock,
 * or the model's cost today where there is none.
 */
export async function getMorningNumbers(date: DateISO): Promise<MorningNumbers> {
  const from = addDays(date, -6);
  const batchIds = await latestBatchIds(addDays(from, -MARGIN_DAYS), addDays(date, MARGIN_DAYS));
  const rows = batchIds.length
    ? await prisma.salesRecord.findMany({
        where: { batchId: { in: batchIds }, business: "WATCH" },
        // The same fixed order as stock deduction, so lines nothing else tells apart get the same keys.
        orderBy: { id: "asc" },
        select: {
          platform: true, orderRef: true, lineRef: true, showDate: true, show: true, tracking: true, stockNumber: true, modelNumber: true,
          qty: true, netItemPriceCents: true, batchId: true, batch: { select: { uploadedAt: true } },
        },
      })
    : [];
  const lines: MorningLine[] = rows.map(({ batch, netItemPriceCents, ...r }) => ({
    ...r, showDate: fromDbDate(r.showDate), uploadedAt: batch.uploadedAt.getTime(), netCents: netItemPriceCents,
  }));

  const days = datesBetween(from, date);
  const orderRefs = [...new Set(lines.filter((l) => l.showDate >= from && l.showDate <= date).map((l) => l.orderRef))];
  const [sales, products, missingReports, startDate] = await Promise.all([
    orderRefs.length
      ? prisma.stockSale.findMany({ where: { orderRef: { in: orderRefs } }, select: { key: true, status: true, costCents: true } })
      : Promise.resolve([]),
    prisma.product.findMany({ select: { model: true, costCents: true } }),
    missingReportsOn(date),
    getStartDate(),
  ]);
  const sold = new Map<string, SoldUnit>(sales.map((s) => [s.key, { status: s.status, costCents: s.costCents }]));
  const costToday = new Map(products.map((p) => [p.model, p.costCents]));

  const figures = morningFigures(lines, sold, costToday, days);
  const week = days.map((d): MorningDay => ({ date: d, ...(figures.get(d) ?? { byShow: new Map(), total: emptyFigures() }) }));
  return { day: week[week.length - 1], week, missingReports, startDate };
}

/**
 * The latest show day with an uploaded watch report, up to today — a report
 * dated tomorrow (a late show) is not a finished day yet.
 */
export async function latestShowDay(today: DateISO): Promise<DateISO | null> {
  const b = await prisma.importBatch.findFirst({
    where: { status: "OK", business: "WATCH", showDate: { lte: toDbDate(today) } },
    orderBy: { showDate: "desc" },
    select: { showDate: true },
  });
  return b ? fromDbDate(b.showDate) : null;
}

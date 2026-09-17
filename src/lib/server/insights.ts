import "server-only";
import { prisma } from "@/lib/db";
import { BUSINESS_SHORT } from "@/lib/domain/business";
import { addDays, datesBetween, fromDbDate, toDbDate, todayISO } from "@/lib/domain/dates";
import { change, hotThreshold, previousRange } from "@/lib/domain/insights";
import type { Change } from "@/lib/domain/insights";
import type { DateISO } from "@/lib/domain/types";
import { latestBatchIds, loadedSpan } from "./sales-data";
import { getSettings } from "./settings";

/**
 * The figures behind the sales screen.
 *
 * Everything here reads only the most recent upload for each day (see
 * `sales-data`), so a corrected re-upload never doubles a day's revenue.
 *
 * Aggregated in the database rather than by pulling rows into memory: a year
 * is around 170,000 watches, and a page that works in September because there
 * are only two weeks of data is not a page that works.
 */

export interface Totals {
  revenueCents: number;
  units: number;
  buyers: number;
  /** Revenue divided by units. The margin proxy until costs exist. */
  avgPriceCents: number;
  shippingCents: number;
  collectedCents: number;
  discountCents: number;
}

export interface DayPoint {
  dateISO: DateISO;
  revenueCents: number;
  units: number;
}

export interface ShowBreakdown {
  key: string;
  revenueCents: number;
  units: number;
  avgPriceCents: number;
  /** Share of the period's revenue, 0–100. */
  sharePercent: number;
}

export interface BestSeller {
  stockNumber: string;
  units: number;
  revenueCents: number;
  avgPriceCents: number;
  allTimeUnits: number;
  hot: boolean;
}

export interface SalesInsights {
  from: DateISO;
  to: DateISO;
  previous: { from: DateISO; to: DateISO };
  hasData: boolean;
  /** The most recent day anything has been loaded for, and its figures. */
  latestDay: DayPoint | null;
  totals: Totals;
  changes: {
    revenue: Change;
    units: Change;
    avgPrice: Change;
    buyers: Change;
  };
  daily: DayPoint[];
  byShow: ShowBreakdown[];
  byPlatform: ShowBreakdown[];
  bySlot: ShowBreakdown[];
  bestSellers: BestSeller[];
  /** How many days in the range actually had sales loaded. */
  daysWithSales: number;
  /** Revenue per day that had sales — a fairer read than dividing by the range. */
  revenuePerActiveDayCents: number;
}

const EMPTY_TOTALS: Totals = {
  revenueCents: 0,
  units: 0,
  buyers: 0,
  avgPriceCents: 0,
  shippingCents: 0,
  collectedCents: 0,
  discountCents: 0,
};

/** Scalar totals for a set of uploads. */
async function totalsFor(batchIds: string[]): Promise<Totals> {
  if (batchIds.length === 0) return EMPTY_TOTALS;

  const [sums, buyers] = await Promise.all([
    prisma.salesRecord.aggregate({
      where: { batchId: { in: batchIds } },
      _sum: {
        netItemPriceCents: true,
        shippingCents: true,
        orderTotalCents: true,
        platformDiscountCents: true,
        sellerDiscountCents: true,
        qty: true,
      },
    }),
    prisma.salesRecord.groupBy({ by: ["buyer"], where: { batchId: { in: batchIds } } }),
  ]);

  const revenueCents = sums._sum.netItemPriceCents ?? 0;
  const units = sums._sum.qty ?? 0;

  return {
    revenueCents,
    units,
    buyers: buyers.length,
    avgPriceCents: units === 0 ? 0 : Math.round(revenueCents / units),
    shippingCents: sums._sum.shippingCents ?? 0,
    collectedCents: sums._sum.orderTotalCents ?? 0,
    discountCents:
      (sums._sum.platformDiscountCents ?? 0) + (sums._sum.sellerDiscountCents ?? 0),
  };
}

function breakdown(
  rows: { key: string; revenueCents: number; units: number }[],
  totalRevenue: number,
): ShowBreakdown[] {
  return rows
    .map((r) => ({
      key: r.key,
      revenueCents: r.revenueCents,
      units: r.units,
      avgPriceCents: r.units === 0 ? 0 : Math.round(r.revenueCents / r.units),
      sharePercent: totalRevenue === 0 ? 0 : (r.revenueCents / totalRevenue) * 100,
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents);
}

export async function getSalesInsights(from: DateISO, to: DateISO): Promise<SalesInsights> {
  const previous = previousRange(from, to);

  const [batchIds, previousBatchIds] = await Promise.all([
    latestBatchIds(from, to),
    latestBatchIds(previous.from, previous.to),
  ]);

  const [totals, previousTotals] = await Promise.all([
    totalsFor(batchIds),
    totalsFor(previousBatchIds),
  ]);

  if (batchIds.length === 0) {
    return {
      from,
      to,
      previous,
      hasData: false,
      latestDay: null,
      totals: EMPTY_TOTALS,
      changes: {
        revenue: change(0, previousTotals.revenueCents),
        units: change(0, previousTotals.units),
        avgPrice: change(0, previousTotals.avgPriceCents),
        buyers: change(0, previousTotals.buyers),
      },
      daily: [],
      byShow: [],
      byPlatform: [],
      bySlot: [],
      bestSellers: [],
      daysWithSales: 0,
      revenuePerActiveDayCents: 0,
    };
  }

  const where = { batchId: { in: batchIds } };

  const [byDate, byShowRows, byPlatformRows, byModel, allTimeModels] = await Promise.all([
    prisma.salesRecord.groupBy({
      by: ["showDate"],
      where,
      _sum: { netItemPriceCents: true, qty: true },
      orderBy: { showDate: "asc" },
    }),
    prisma.salesRecord.groupBy({
      by: ["business", "show"],
      where,
      _sum: { netItemPriceCents: true, qty: true },
    }),
    prisma.salesRecord.groupBy({
      by: ["business", "platform"],
      where,
      _sum: { netItemPriceCents: true, qty: true },
    }),
    prisma.salesRecord.groupBy({
      by: ["stockNumber"],
      where,
      _sum: { netItemPriceCents: true, qty: true },
      orderBy: { _sum: { qty: "desc" } },
      take: 12,
    }),
    // All time, for the fire: a model is hot because it keeps selling, not
    // because it had one good fortnight.
    prisma.salesRecord.groupBy({
      by: ["stockNumber"],
      _sum: { qty: true },
    }),
  ]);

  const daily: DayPoint[] = byDate.map((d) => ({
    dateISO: fromDbDate(d.showDate),
    revenueCents: d._sum.netItemPriceCents ?? 0,
    units: d._sum.qty ?? 0,
  }));

  // Every day in the range, so a gap reads as a gap rather than closing up.
  const salesByDate = new Map(daily.map((d) => [d.dateISO, d]));
  const filled: DayPoint[] = datesBetween(from, to).map(
    (dateISO) => salesByDate.get(dateISO) ?? { dateISO, revenueCents: 0, units: 0 },
  );

  /*
    Diamonds are never folded into a watch show's line.

    "TikTok AM" is a show name on both sides, so grouping by it alone would put
    a diamond day show and a watch day show on one row — and the boss would be
    reading a number that is two businesses added together without being told.
    Naming the diamond rows keeps them apart whatever else starts running: a
    diamond night show, or a diamond eBay show, appears as its own line the day
    its sales arrive, with nothing here to change.
  */
  const byShow = breakdown(
    byShowRows.map((r) => ({
      key: r.business === "WATCH" ? r.show : `${BUSINESS_SHORT[r.business]} ${r.show}`,
      revenueCents: r._sum.netItemPriceCents ?? 0,
      units: r._sum.qty ?? 0,
    })),
    totals.revenueCents,
  );

  const byPlatform = breakdown(
    byPlatformRows.map((r) => {
      const platform = r.platform === "TIKTOK" ? "TikTok" : "eBay";
      return {
        key: r.business === "WATCH" ? platform : `${BUSINESS_SHORT[r.business]} ${platform}`,
        revenueCents: r._sum.netItemPriceCents ?? 0,
        units: r._sum.qty ?? 0,
      };
    }),
    totals.revenueCents,
  );

  // Day against night, across both marketplaces. Read off the show name, which
  // is where the AM/PM already lives.
  const slots = new Map<string, { revenueCents: number; units: number }>();
  for (const row of byShowRows) {
    const slot = row.show.trim().toUpperCase().endsWith("AM") ? "Day" : "Night";
    const found = slots.get(slot) ?? { revenueCents: 0, units: 0 };
    found.revenueCents += row._sum.netItemPriceCents ?? 0;
    found.units += row._sum.qty ?? 0;
    slots.set(slot, found);
  }
  const bySlot = breakdown(
    [...slots.entries()].map(([key, v]) => ({ key, ...v })),
    totals.revenueCents,
  );

  const allTime = new Map(allTimeModels.map((m) => [m.stockNumber, m._sum.qty ?? 0]));
  const threshold = hotThreshold([...allTime.values()]);

  const bestSellers: BestSeller[] = byModel.map((m) => {
    const units = m._sum.qty ?? 0;
    const revenueCents = m._sum.netItemPriceCents ?? 0;
    const allTimeUnits = allTime.get(m.stockNumber) ?? units;
    return {
      stockNumber: m.stockNumber,
      units,
      revenueCents,
      avgPriceCents: units === 0 ? 0 : Math.round(revenueCents / units),
      allTimeUnits,
      hot: allTimeUnits >= threshold,
    };
  });

  const daysWithSales = daily.length;

  return {
    from,
    to,
    previous,
    hasData: true,
    latestDay: daily.length > 0 ? daily[daily.length - 1] : null,
    totals,
    changes: {
      revenue: change(totals.revenueCents, previousTotals.revenueCents),
      units: change(totals.units, previousTotals.units),
      avgPrice: change(totals.avgPriceCents, previousTotals.avgPriceCents),
      buyers: change(totals.buyers, previousTotals.buyers),
    },
    daily: filled,
    byShow,
    byPlatform,
    bySlot,
    bestSellers,
    daysWithSales,
    revenuePerActiveDayCents:
      daysWithSales === 0 ? 0 : Math.round(totals.revenueCents / daysWithSales),
  };
}

/**
 * The two figures worth putting on a dashboard.
 *
 * Revenue answers "are we doing better". Volume beside it is what separates a
 * good fortnight from a discounted one — revenue can rise while every watch
 * sells for less, and on its own that reads as success.
 *
 * Everything else belongs on Sales insights. A dashboard that tries to be a
 * report stops being glanceable, which is the only thing it is for.
 */
export interface SalesHeadline {
  from: DateISO;
  to: DateISO;
  revenueCents: number;
  units: number;
  revenue: Change;
  unitsChange: Change;
  hasData: boolean;
}

export async function salesHeadline(days = 30): Promise<SalesHeadline> {
  const settings = await getSettings();
  // Ends yesterday: a show day's sales do not exist until the next morning, so
  // including today would always end on a zero.
  const to = addDays(todayISO(settings.timezone), -1);
  const from = addDays(to, -(days - 1));
  const previous = previousRange(from, to);

  const [ids, previousIds] = await Promise.all([
    latestBatchIds(from, to),
    latestBatchIds(previous.from, previous.to),
  ]);
  const [now, before] = await Promise.all([totalsFor(ids), totalsFor(previousIds)]);

  return {
    from,
    to,
    revenueCents: now.revenueCents,
    units: now.units,
    revenue: change(now.revenueCents, before.revenueCents),
    unitsChange: change(now.units, before.units),
    hasData: ids.length > 0,
  };
}

/** The same, but it never throws — see the banner for why. */
export async function salesHeadlineSafe(days = 30): Promise<SalesHeadline | null> {
  try {
    return await salesHeadline(days);
  } catch (error) {
    console.error("Could not read the sales headline for the dashboard:", error);
    return null;
  }
}

/* --------------------------------------------------------------- the periods */

export interface RangePreset {
  key: string;
  label: string;
  from: DateISO;
  to: DateISO;
}

/** What the page shows when nothing is asked for. */
export const DEFAULT_PERIOD = "30";

/**
 * The stretches worth looking at.
 *
 * Ends yesterday rather than today throughout, because a show day's sales do
 * not exist until its reports are uploaded the next morning. A range including
 * today would always end on a zero and make every trend look like a collapse.
 *
 * Yesterday is first because it is the question asked most often — last night's
 * shows are the only ones whose figures have just landed. Being a single day it
 * compares against the day before, which is the honest comparison: two days
 * apart is what the reports actually let you see.
 */
export async function rangePresets(): Promise<RangePreset[]> {
  const settings = await getSettings();
  const today = todayISO(settings.timezone);
  const end = addDays(today, -1);
  const span = await loadedSpan();

  const presets: RangePreset[] = [
    { key: "1", label: "Yesterday", from: end, to: end },
    { key: "7", label: "Last 7 days", from: addDays(end, -6), to: end },
    { key: "30", label: "Last 30 days", from: addDays(end, -29), to: end },
    { key: "90", label: "Last 90 days", from: addDays(end, -89), to: end },
  ];

  if (span) {
    presets.push({ key: "all", label: "Everything loaded", from: span.first, to: span.last });
  }
  return presets;
}

export function resolveRange(
  presets: RangePreset[],
  key: string | undefined,
  from: string | undefined,
  to: string | undefined,
): { from: DateISO; to: DateISO; label: string; key: string } {
  if (from && to && from <= to) {
    return { from, to, label: `${from} to ${to}`, key: "custom" };
  }
  // By key, never by position: adding a preset must not silently move what the
  // page opens on.
  const found =
    presets.find((p) => p.key === key) ??
    presets.find((p) => p.key === DEFAULT_PERIOD) ??
    presets[0];
  return { from: found.from, to: found.to, label: found.label, key: found.key };
}

export { toDbDate };

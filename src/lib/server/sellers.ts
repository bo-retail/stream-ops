import "server-only";
import { prisma } from "@/lib/db";
import type { Business } from "@/lib/domain/business";
import { datesBetween, fromDbDate, toDbDate } from "@/lib/domain/dates";
import { slotOfSalesShow } from "@/lib/domain/imports/types";
import { costedUnits } from "@/lib/domain/morning";
import { showKey } from "@/lib/domain/payroll";
import { fileLoadedFor, scoreSellers } from "@/lib/domain/sellers";
import type { SellerResult, SellerShow } from "@/lib/domain/sellers";
import type { DateISO } from "@/lib/domain/types";
import { salesByShow } from "./payroll";
import { loadSaleInputs } from "./morning";
import { latestBatches } from "./sales-data";

export interface SellerInsights extends SellerResult {
  business: Business;
  from: DateISO;
  to: DateISO;
  names: Record<string, { name: string; active: boolean }>;
  /** Shows on the rota whose day's file for that platform was never loaded. */
  showsWithoutSales: number;
}

/**
 * Seller scores for one business over a range.
 *
 * Sales are joined to the rota exactly as payroll joins them — by where the
 * watch sold, not the listing's tag — so a show's figure here is the one its
 * commission is paid on, and the one Sales insights shows.
 *
 * A show only counts once its own file is in — its line on the day's
 * checklist, not just any file that day. Before then its sales are not zero,
 * they are unknown, and scoring it as a dead night would mark down whoever was
 * on it. A show whose file is in and sold nothing is a real zero and counts.
 *
 * Only streamers are scored. Somebody from another team covering a seat is
 * left out of the people on that show, so the streamer beside them carries it.
 */
export async function getSellerInsights(
  business: Business,
  from: DateISO,
  to: DateISO,
): Promise<SellerInsights> {
  // Started now, alongside the rest, rather than after it.
  const costInputs = business === "WATCH" ? loadSaleInputs(from, to) : null;
  const [sales, batches, rota] = await Promise.all([
    salesByShow(from, to),
    latestBatches(from, to),
    prisma.show.findMany({
      where: {
        business,
        date: { gte: toDbDate(from), lte: toDbDate(to) },
        // A cancelled show ran nobody and sold nothing.
        status: "SCHEDULED",
      },
      select: {
        id: true,
        date: true,
        platform: true,
        slot: true,
        startsAt: true,
        endsAt: true,
        assignments: { select: { userId: true, user: { select: { team: true, role: true } } } },
      },
    }),
  ]);

  const loaded = new Set(
    batches
      .filter((b) => b.business === business)
      // An upload from before the day became a checklist names no platform: it
      // was the whole day.
      .map((b) => `${b.platform ?? "*"}|${b.slot ?? ""}|${b.dateISO}`),
  );

  /*
    What each show's sales cost us, by the same costing as the Profitability
    tab (`costedUnits`): watches only, since diamonds have no master cost.
  */
  const costByShow = new Map<string, { revenue: number; cogs: number }>();
  if (costInputs) {
    const { lines, sold, costToday } = await costInputs;
    for (const u of costedUnits(lines, sold, costToday, datesBetween(from, to))) {
      if (u.cancelled || u.costCents === null) continue;
      const key = showKey({ business, dateISO: u.day, platform: u.platform, slot: slotOfSalesShow(u.show) });
      const c = costByShow.get(key) ?? { revenue: 0, cogs: 0 };
      c.revenue += u.cents;
      c.cogs += u.costCents;
      costByShow.set(key, c);
    }
  }

  const shows: SellerShow[] = [];
  let showsWithoutSales = 0;
  for (const show of rota) {
    const dateISO = fromDbDate(show.date);
    if (!fileLoadedFor(loaded, { platform: show.platform, slot: show.slot, dateISO })) {
      showsWithoutSales += 1;
      continue;
    }
    const key = showKey({ business, dateISO, platform: show.platform, slot: show.slot });
    const sold = sales.get(key);
    const cost = costByShow.get(key);
    shows.push({
      id: show.id,
      platform: show.platform,
      slot: show.slot,
      dateISO,
      minutes: Math.max(0, Math.round((show.endsAt.getTime() - show.startsAt.getTime()) / 60_000)),
      revenueCents: sold?.netRevenueCents ?? 0,
      units: sold?.units ?? 0,
      ...(cost ? { costedRevenueCents: cost.revenue, cogsCents: cost.cogs } : {}),
      people: show.assignments
        .filter((a) => a.user.team === "STREAMING" && a.user.role === "EMPLOYEE")
        .map((a) => a.userId),
    });
  }

  const result = scoreSellers(shows);

  const ids = [
    ...new Set([
      ...result.sellers.map((s) => s.userId),
      ...result.pairings.flatMap((p) => [p.a, p.b]),
      ...result.sellers.flatMap((s) => (s.mainPartner ? [s.mainPartner.userId] : [])),
    ]),
  ];
  const users =
    ids.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, isActive: true },
        });

  return {
    ...result,
    business,
    from,
    to,
    names: Object.fromEntries(users.map((u) => [u.id, { name: u.name, active: u.isActive }])),
    showsWithoutSales,
  };
}

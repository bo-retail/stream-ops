import "server-only";
import { prisma } from "@/lib/db";
import { fromDbDate, toDbDate } from "@/lib/domain/dates";
import { payFor, showKey } from "@/lib/domain/payroll";
import type { PersonPay, Rates, ShowKey } from "@/lib/domain/payroll";
import { BUSINESS_SHORT } from "@/lib/domain/business";
import type { Business } from "@/lib/domain/business";
import { PLATFORM_SHORT, SLOT_SHORT } from "@/lib/domain/types";
import type { DateISO, Platform, Slot } from "@/lib/domain/types";
import { fieldsToPosition, positionName } from "@/app/(app)/admin/team/position";
import { latestBatchIds } from "./sales-data";
import { getSettings } from "./settings";
import { getEntriesInRange, totalsByPerson } from "./timeclock";

/**
 * A pay period, priced.
 *
 * Hours come from the timesheet, which is already the authority on what counts.
 * Commission comes from the shows somebody was on and what those shows sold —
 * two facts that live a long way apart, and joining them is most of this file.
 *
 * The join is where the watch sold, not the tag on the listing. Whoever was
 * live when the buyer paid earned it: a watch listed for the morning show that
 * somebody buys during the evening one was sold by the evening pair, and it is
 * theirs.
 *
 * That is `SalesRecord.show`, which the ingestion has already worked out — from
 * the order's timestamp on TikTok, and from the Custom Label on eBay, which
 * records no time of day at all and so has nothing else to go on (R15). Using
 * it here means a show's commission is exactly one per cent of what the Sales
 * insights tab says that show made. The two screens cannot disagree.
 */

export interface ShowSales {
  key: ShowKey;
  label: string;
  netRevenueCents: number;
  units: number;
  /** Null when nothing on the rota matches — sales nobody can be paid for. */
  showId: string | null;
  people: { userId: string; name: string }[];
}

export interface PayrollPeriod {
  from: DateISO;
  to: DateISO;
  rates: Rates;
  /**
   * What each kind of show pays each of its pair, in basis points.
   *
   * Separate from `rates` because it is the one figure that genuinely differs
   * between watches and diamonds — a piece is worth several times a watch, so
   * the same percentage is a very different amount of money. The hourly rates
   * are not split this way: a streamer works one kind of show, so anyone paid
   * differently gets their own rate on their row.
   */
  commissionByBusiness: Record<Business, number>;
  people: PersonPay[];
  shows: ShowSales[];
  /** Sales tagged for a show that is not on any rota, so nobody is paid them. */
  unattributed: ShowSales[];
  totals: {
    minutes: number;
    hourlyPayCents: number;
    commissionCents: number;
    totalCents: number;
    openShifts: number;
    /** People with hours but no rate set. */
    unrated: number;
  };
  /** True when no sales have been loaded for any day in the period. */
  noSalesLoaded: boolean;
}

/**
 * What a show is called on the payroll screen.
 *
 * Diamonds are named; watches are not. Two shows can now share a platform, a
 * slot and a date, so a payroll line reading "TikTok Day · 2026-09-18" twice
 * with different money against each would be unreadable. Naming only the
 * exception keeps every other line exactly as it was.
 */
function labelFor(business: Business, platform: Platform, slot: Slot): string {
  const show = `${PLATFORM_SHORT[platform]} ${SLOT_SHORT[slot]}`;
  return business === "WATCH" ? show : `${BUSINESS_SHORT[business]} ${show}`;
}

/**
 * What each show sold, keyed the way a rota row can be keyed too.
 *
 * `show` is where the watch sold — the column the Sales insights tab totals —
 * so a show's commission is one per cent of the figure already on that screen.
 * `showDate` is the day it belongs to, which is why this needs no window wider
 * than the period: unlike a shift tag, it cannot name some other day.
 */
async function salesByShow(from: DateISO, to: DateISO): Promise<Map<string, ShowSales>> {
  const batchIds = await latestBatchIds(from, to);
  const byShow = new Map<string, ShowSales>();
  if (batchIds.length === 0) return byShow;

  const rows = await prisma.salesRecord.groupBy({
    // Grouped by business as well, because a watch TikTok Day and a diamond
    // TikTok Day on one date are otherwise the same row here — and their
    // takings would be added together before anybody is paid out of them.
    by: ["business", "show", "showDate", "platform"],
    where: { batchId: { in: batchIds } },
    _sum: { netItemPriceCents: true, qty: true },
  });

  for (const row of rows) {
    const key: ShowKey = {
      business: row.business,
      dateISO: fromDbDate(row.showDate),
      platform: row.platform,
      // "TikTok AM" / "eBay PM" — the half is the last two characters.
      slot: row.show.trim().toUpperCase().endsWith("AM") ? "DAY" : "NIGHT",
    };

    const id = showKey(key);
    const found = byShow.get(id) ?? {
      key,
      label: `${labelFor(key.business, key.platform, key.slot)} · ${key.dateISO}`,
      netRevenueCents: 0,
      units: 0,
      showId: null,
      people: [],
    };
    found.netRevenueCents += row._sum.netItemPriceCents ?? 0;
    found.units += row._sum.qty ?? 0;
    byShow.set(id, found);
  }

  return byShow;
}

export async function getPayrollPeriod(from: DateISO, to: DateISO): Promise<PayrollPeriod> {
  const settings = await getSettings();
  const rates: Rates = {
    streamerHourlyCents: settings.streamerHourlyCents,
    shippingHourlyCents: settings.shippingHourlyCents,
    streamerCommissionBps: settings.streamerCommissionBps,
  };

  /*
    The commission each kind of show pays.

    Read once for the whole run rather than per show. A business with no row —
    which cannot happen, since the migration seeds both — falls back to the
    shared rate rather than paying nothing, because a silent zero is the one
    failure this file exists to avoid.
  */
  const businessRates = new Map(
    (await prisma.businessSettings.findMany({ select: { business: true, streamerCommissionBps: true } })).map(
      (r) => [r.business, r.streamerCommissionBps] as const,
    ),
  );
  const bpsFor = (business: Business): number =>
    businessRates.get(business) ?? settings.streamerCommissionBps;

  const [entries, sales, rota, staff] = await Promise.all([
    getEntriesInRange({ from, to }),
    salesByShow(from, to),
    // Who was on which show. Cancelled shows are excluded: nobody worked them
    // and they sold nothing.
    prisma.show.findMany({
      where: { date: { gte: toDbDate(from), lte: toDbDate(to) }, status: "SCHEDULED" },
      select: {
        id: true,
        date: true,
        business: true,
        platform: true,
        slot: true,
        assignments: { select: { userId: true, user: { select: { name: true } } } },
      },
    }),
    prisma.user.findMany({
      select: {
        id: true,
        name: true,
        team: true,
        role: true,
        isActive: true,
        hourlyRateCents: true,
        commissionBps: true,
      },
    }),
  ]);

  // Attach the rota to the sales. A show with no sales still appears, so an
  // empty night is visible rather than absent.
  for (const show of rota) {
    const key: ShowKey = {
      business: show.business,
      dateISO: fromDbDate(show.date),
      platform: show.platform,
      slot: show.slot,
    };
    const id = showKey(key);
    const found = sales.get(id) ?? {
      key,
      label: `${labelFor(key.business, key.platform, key.slot)} · ${key.dateISO}`,
      netRevenueCents: 0,
      units: 0,
      showId: null,
      people: [],
    };
    found.showId = show.id;
    found.people = show.assignments.map((a) => ({ userId: a.userId, name: a.user.name }));
    sales.set(id, found);
  }

  const allShows = [...sales.values()].sort(
    (a, b) => a.key.dateISO.localeCompare(b.key.dateISO) || a.label.localeCompare(b.label),
  );
  const attributed = allShows.filter((s) => s.showId !== null);
  const unattributed = allShows.filter((s) => s.showId === null && s.netRevenueCents > 0);

  // What each person earned commission on.
  const showsByPerson = new Map<string, ShowSales[]>();
  for (const show of attributed) {
    for (const person of show.people) {
      const list = showsByPerson.get(person.userId) ?? [];
      list.push(show);
      showsByPerson.set(person.userId, list);
    }
  }

  const hours = new Map(totalsByPerson(entries).map((t) => [t.userId, t]));
  const byId = new Map(staff.map((s) => [s.id, s]));

  // Everybody who either worked or earned. Somebody with neither is not on a
  // payroll run at all.
  const ids = new Set<string>([...hours.keys(), ...showsByPerson.keys()]);

  const people: PersonPay[] = [];
  for (const id of ids) {
    const person = byId.get(id);
    if (!person) continue;
    const worked = hours.get(id);

    people.push(
      payFor({
        userId: id,
        name: person.name,
        team: person.team,
        position: positionName(fieldsToPosition(person.role, person.team)),
        minutes: worked?.minutes ?? 0,
        openShifts: worked?.openEntries ?? 0,
        override: {
          hourlyRateCents: person.hourlyRateCents,
          commissionBps: person.commissionBps,
        },
        rates,
        shows: (showsByPerson.get(id) ?? []).map((s) => ({
          key: s.key,
          label: s.label,
          netRevenueCents: s.netRevenueCents,
          // Each show pays its own kind of business's rate.
          bps: bpsFor(s.key.business),
        })),
      }),
    );
  }

  people.sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name));

  return {
    from,
    to,
    rates,
    commissionByBusiness: { WATCH: bpsFor("WATCH"), DIAMOND: bpsFor("DIAMOND") },
    people,
    shows: attributed,
    unattributed,
    totals: {
      minutes: people.reduce((n, p) => n + p.minutes, 0),
      hourlyPayCents: people.reduce((n, p) => n + p.hourlyPayCents, 0),
      commissionCents: people.reduce((n, p) => n + p.commissionCents, 0),
      totalCents: people.reduce((n, p) => n + p.totalCents, 0),
      openShifts: people.reduce((n, p) => n + p.openShifts, 0),
      unrated: people.filter((p) => p.unrated).length,
    },
    noSalesLoaded: attributed.every((s) => s.netRevenueCents === 0),
  };
}

/** Everyone who can be given a rate, for the rates table. */
export async function listRatePeople() {
  const people = await prisma.user.findMany({
    where: { isActive: true },
    orderBy: [{ team: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      team: true,
      role: true,
      hourlyRateCents: true,
      commissionBps: true,
    },
  });

  return people.map((p) => ({
    ...p,
    position: positionName(fieldsToPosition(p.role, p.team)),
  }));
}

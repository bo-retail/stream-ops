import "server-only";
import { prisma } from "@/lib/db";
import { addDays, fromDbDate, toDbDate } from "@/lib/domain/dates";
import { payFor, payableShowFor, showKey } from "@/lib/domain/payroll";
import type { PersonPay, Rates, ShowKey } from "@/lib/domain/payroll";
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
 * The join is the shift tag, not the show a watch sold in. The master
 * specification is explicit that they are different questions: an item listed
 * for the morning show can sell in the evening one, and the morning team still
 * earned it. See `payableShowFor`.
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

function labelFor(platform: Platform, slot: Slot): string {
  return `${PLATFORM_SHORT[platform]} ${SLOT_SHORT[slot]}`;
}

/**
 * What each show sold, keyed the way a rota row can be keyed too.
 *
 * The window is wider than the period on purpose. A sale is attributed by the
 * date on its tag, and a tag can name a day other than the one the file was
 * exported for — an item listed for Sunday's show that sold on Monday arrives
 * in Monday's upload. Reading only the period's own uploads would drop it. The
 * results are filtered back to the period afterwards, by tag date.
 */
const TAG_SPILL_DAYS = 7;

async function salesByShow(from: DateISO, to: DateISO): Promise<Map<string, ShowSales>> {
  const batchIds = await latestBatchIds(addDays(from, -TAG_SPILL_DAYS), addDays(to, TAG_SPILL_DAYS));
  const byShow = new Map<string, ShowSales>();
  if (batchIds.length === 0) return byShow;

  const rows = await prisma.salesRecord.groupBy({
    by: ["shiftTag", "platform"],
    where: { batchId: { in: batchIds } },
    _sum: { netItemPriceCents: true, qty: true },
  });

  for (const row of rows) {
    const key = payableShowFor(row.shiftTag, row.platform);
    // An unreadable tag is money that cannot be attributed to anybody. It is
    // not silently dropped — `unattributedTagless` below reports it — but it
    // cannot be added to a show that was never named.
    if (!key) continue;
    if (key.dateISO < from || key.dateISO > to) continue;

    const id = showKey(key);
    const found = byShow.get(id) ?? {
      key,
      label: `${labelFor(key.platform, key.slot)} · ${key.dateISO}`,
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

/** Net revenue on tags nobody could read, which is nobody's commission. */
async function taglessRevenue(from: DateISO, to: DateISO): Promise<number> {
  const batchIds = await latestBatchIds(from, to);
  if (batchIds.length === 0) return 0;

  const rows = await prisma.salesRecord.groupBy({
    by: ["shiftTag", "platform"],
    where: { batchId: { in: batchIds } },
    _sum: { netItemPriceCents: true },
  });

  return rows
    .filter((r) => payableShowFor(r.shiftTag, r.platform) === null)
    .reduce((n, r) => n + (r._sum.netItemPriceCents ?? 0), 0);
}

export async function getPayrollPeriod(from: DateISO, to: DateISO): Promise<PayrollPeriod> {
  const settings = await getSettings();
  const rates: Rates = {
    streamerHourlyCents: settings.streamerHourlyCents,
    shippingHourlyCents: settings.shippingHourlyCents,
    streamerCommissionBps: settings.streamerCommissionBps,
  };

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
      dateISO: fromDbDate(show.date),
      platform: show.platform,
      slot: show.slot,
    };
    const id = showKey(key);
    const found = sales.get(id) ?? {
      key,
      label: `${labelFor(key.platform, key.slot)} · ${key.dateISO}`,
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
        })),
      }),
    );
  }

  people.sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name));

  const tagless = await taglessRevenue(from, to);
  if (tagless > 0) {
    unattributed.push({
      key: { dateISO: from, platform: "TIKTOK", slot: "DAY" },
      label: "Sales whose shift tag could not be read",
      netRevenueCents: tagless,
      units: 0,
      showId: null,
      people: [],
    });
  }

  return {
    from,
    to,
    rates,
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

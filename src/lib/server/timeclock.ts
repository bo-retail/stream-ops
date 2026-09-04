import "server-only";
import { prisma } from "@/lib/db";
import { fromDbDate, toDbDate } from "@/lib/domain/dates";
import { paidWindow, showForClockIn } from "@/lib/domain/hours";
import { periodFor } from "@/lib/domain/periods";
import type { Period } from "@/lib/domain/periods";
import { PLATFORM_SHORT, SLOT_SHORT } from "@/lib/domain/types";
import type { DateISO } from "@/lib/domain/types";
import { getSettings } from "./settings";

/**
 * The time clock.
 *
 * Raw clock times are recorded exactly as pressed and never altered. What gets
 * paid is derived: a streamer's entry is measured against the show they were on
 * (see `src/lib/domain/hours.ts`), and shipping — who have no schedule — are
 * paid the hours they clocked.
 */

export interface TimeEntryView {
  id: string;
  userId: string;
  userName: string;
  team: "STREAMING" | "SHIPPING";

  /** What actually happened. Never adjusted. */
  clockInAt: Date;
  clockOutAt: Date | null;
  startHM: string;
  endHM: string | null;
  /** Raw clocked minutes, before the shift is taken into account. */
  clockedMinutes: number | null;

  /** What counts. Equal to the raw times when there is no show attached. */
  paidFromHM: string;
  paidToHM: string | null;
  paidMinutes: number | null;

  /** The show this was measured against, if any. */
  shift: { label: string; startHM: string; endHM: string } | null;
  lateMinutes: number;
  leftEarlyMinutes: number;
  /** Clocked time that falls outside the shift and is not paid. */
  unpaidMinutes: number;

  /** Business-zone date the shift started on. Used for grouping and reports. */
  dateISO: DateISO;
  note: string | null;
  source: "SELF" | "ADMIN";
  version: number;
  edited: boolean;
}

export interface RevisionView {
  version: number;
  clockInAt: Date;
  clockOutAt: Date | null;
  note: string | null;
  reason: string | null;
  changedByName: string;
  changedAt: Date;
}

function formatters(timezone: string) {
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return { clock, day };
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}

const ROW_SELECT = {
  id: true,
  userId: true,
  clockInAt: true,
  clockOutAt: true,
  note: true,
  source: true,
  version: true,
  user: { select: { name: true, team: true } },
  show: {
    select: { date: true, platform: true, slot: true, startsAt: true, endsAt: true, status: true },
  },
} as const;

type Row = {
  id: string;
  userId: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  note: string | null;
  source: "SELF" | "ADMIN";
  version: number;
  user: { name: string; team: "STREAMING" | "SHIPPING" };
  show: {
    date: Date;
    platform: "TIKTOK" | "EBAY";
    slot: "DAY" | "NIGHT";
    startsAt: Date;
    endsAt: Date;
    status: "SCHEDULED" | "CANCELLED";
  } | null;
};

function toView(row: Row, timezone: string): TimeEntryView {
  const { clock, day } = formatters(timezone);

  // A cancelled show is not a shift anybody was meant to work, so it stops
  // bounding the hours — whatever they actually clocked stands.
  const shift = row.show && row.show.status === "SCHEDULED" ? row.show : null;

  const paid = paidWindow(
    { clockInAt: row.clockInAt, clockOutAt: row.clockOutAt },
    shift ? { startsAt: shift.startsAt, endsAt: shift.endsAt } : null,
  );

  return {
    id: row.id,
    userId: row.userId,
    userName: row.user.name,
    team: row.user.team,

    clockInAt: row.clockInAt,
    clockOutAt: row.clockOutAt,
    startHM: clock.format(row.clockInAt),
    endHM: row.clockOutAt ? clock.format(row.clockOutAt) : null,
    clockedMinutes: row.clockOutAt ? minutesBetween(row.clockInAt, row.clockOutAt) : null,

    paidFromHM: clock.format(paid.from),
    paidToHM: paid.to ? clock.format(paid.to) : null,
    paidMinutes: paid.minutes,

    shift: shift
      ? {
          label: `${PLATFORM_SHORT[shift.platform]} ${SLOT_SHORT[shift.slot]}`,
          startHM: clock.format(shift.startsAt),
          endHM: clock.format(shift.endsAt),
        }
      : null,
    lateMinutes: paid.lateMinutes,
    leftEarlyMinutes: paid.leftEarlyMinutes,
    unpaidMinutes: paid.unpaidMinutes,

    // Grouped by the day the shift *started*, so a night running past midnight
    // stays on the day the person came in rather than splitting across two.
    dateISO: day.format(row.clockInAt),
    note: row.note,
    source: row.source,
    version: row.version,
    // Not simply version > 1: clocking out is version 2 of every ordinary
    // entry. Only an admin edit sets the source to ADMIN.
    edited: row.source === "ADMIN" && row.version > 1,
  };
}

/** The entry a person is currently clocked into, if any. */
export async function getOpenEntry(userId: string): Promise<TimeEntryView | null> {
  const settings = await getSettings();
  const row = await prisma.timeEntry.findFirst({
    where: { userId, clockOutAt: null },
    select: ROW_SELECT,
  });
  return row ? toView(row as Row, settings.timezone) : null;
}

const startOfDay = (dateISO: DateISO, dayOffset = 0) => {
  const d = toDbDate(dateISO);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d;
};

const endOfDay = (dateISO: DateISO, dayOffset = 0) => {
  const d = toDbDate(dateISO);
  d.setUTCDate(d.getUTCDate() + 1 + dayOffset);
  return d;
};

/**
 * Every entry in a date range, for the admin screen and the payroll export.
 *
 * Read with a day of slack either side and then filtered by business-zone date:
 * a shift starting at 23:00 local is a different UTC day and would otherwise
 * fall out of the report it belongs in.
 */
export async function getEntriesInRange(range: {
  from: DateISO;
  to: DateISO;
  userId?: string;
}): Promise<TimeEntryView[]> {
  const settings = await getSettings();
  const rows = await prisma.timeEntry.findMany({
    where: {
      ...(range.userId ? { userId: range.userId } : {}),
      clockInAt: { gte: startOfDay(range.from, -1), lt: endOfDay(range.to, 1) },
    },
    orderBy: [{ clockInAt: "asc" }],
    select: ROW_SELECT,
  });

  return rows
    .map((r) => toView(r as Row, settings.timezone))
    .filter((e) => e.dateISO >= range.from && e.dateISO <= range.to);
}

/**
 * The show a clock-in right now should be measured against.
 *
 * Only shows this person is actually on, only ones still scheduled, and only
 * within a few hours of now — so somebody clocking in at 3am is not silently
 * measured against a show that finished at 7pm.
 */
export async function findShiftForClockIn(
  userId: string,
  at: Date,
): Promise<{ id: string; startsAt: Date; endsAt: Date } | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { team: true } });
  // Shipping has no schedule at all — nothing to measure against, by design.
  if (!user || user.team === "SHIPPING") return null;

  const halfDay = 12 * 60 * 60 * 1000;
  const rows = await prisma.assignment.findMany({
    where: {
      userId,
      show: {
        status: "SCHEDULED",
        // Only a published schedule counts. A draft can still be rearranged, so
        // clamping somebody's pay to a shift that has not been announced would
        // dock them against hours they were never told to work.
        release: { scheduleStatus: "PUBLISHED" },
        startsAt: { lte: new Date(at.getTime() + halfDay) },
        endsAt: { gte: new Date(at.getTime() - halfDay) },
      },
    },
    select: { show: { select: { id: true, startsAt: true, endsAt: true } } },
  });

  return showForClockIn(
    at,
    rows.map((r) => r.show),
  );
}

/** Every version an entry has held, newest first. */
export async function getRevisions(timeEntryId: string): Promise<RevisionView[]> {
  const rows = await prisma.timeEntryRevision.findMany({
    where: { timeEntryId },
    orderBy: { version: "desc" },
    select: {
      version: true,
      clockInAt: true,
      clockOutAt: true,
      note: true,
      reason: true,
      changedAt: true,
      changedBy: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    version: r.version,
    clockInAt: r.clockInAt,
    clockOutAt: r.clockOutAt,
    note: r.note,
    reason: r.reason,
    changedByName: r.changedBy.name,
    changedAt: r.changedAt,
  }));
}

export interface PersonTotal {
  userId: string;
  name: string;
  team: "STREAMING" | "SHIPPING";
  entries: number;
  /** Paid minutes — what goes to payroll. */
  minutes: number;
  /** Clocked minutes, before the shift bounded them. */
  clockedMinutes: number;
  openEntries: number;
  lateMinutes: number;
  leftEarlyMinutes: number;
}

/** Hours per person over a range — the paid figure, and what it came from. */
export function totalsByPerson(entries: TimeEntryView[]): PersonTotal[] {
  const byUser = new Map<string, PersonTotal>();

  for (const entry of entries) {
    const total = byUser.get(entry.userId) ?? {
      userId: entry.userId,
      name: entry.userName,
      team: entry.team,
      entries: 0,
      minutes: 0,
      clockedMinutes: 0,
      openEntries: 0,
      lateMinutes: 0,
      leftEarlyMinutes: 0,
    };
    total.entries += 1;
    if (entry.paidMinutes === null) total.openEntries += 1;
    else total.minutes += entry.paidMinutes;
    total.clockedMinutes += entry.clockedMinutes ?? 0;
    total.lateMinutes += entry.lateMinutes;
    total.leftEarlyMinutes += entry.leftEarlyMinutes;
    byUser.set(entry.userId, total);
  }

  return [...byUser.values()].sort(
    (a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name),
  );
}

/** The pay period a date falls in — the same 1st–15th / 16th–end split. */
export function payPeriodFor(dateISO: DateISO): Period {
  return periodFor(dateISO);
}

export { fromDbDate };

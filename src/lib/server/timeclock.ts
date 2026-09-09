import "server-only";
import { prisma } from "@/lib/db";
import { fromDbDate, toDbDate } from "@/lib/domain/dates";
import { paidWindow } from "@/lib/domain/hours";
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
  source: "SELF" | "ADMIN" | "SCHEDULE";
  version: number;
  edited: boolean;
  /** Printed from the published schedule rather than clocked or typed. */
  fromSchedule: boolean;
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
  source: "SELF" | "ADMIN" | "SCHEDULE";
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

  /*
    Only a self-clocked entry is measured against a shift.

    Clamping exists to answer "they turned up twenty minutes early, do we pay
    it" — a question that only arises when somebody pressed a button. It must
    not touch the other two sources:

      SCHEDULE  the times *are* the shift, so clamping is a no-op until the
                boss corrects one — at which point clamping would quietly undo
                the correction and pay the original hours anyway.
      ADMIN     somebody typed those hours deliberately, with a reason.

    Historical clocked entries keep their behaviour exactly, which is why this
    turns on the source rather than on the presence of a show.
  */
  const clampable = row.source === "SELF";

  // A cancelled show is not a shift anybody was meant to work, so it stops
  // bounding the hours — whatever they actually clocked stands.
  const shift = clampable && row.show && row.show.status === "SCHEDULED" ? row.show : null;

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
    fromSchedule: row.source === "SCHEDULE",
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
 * Nothing. A clock-in is no longer attached to a show.
 *
 * It used to find the show somebody was turning up for, so their hours could be
 * measured against it. That question has gone: a streamer's show hours come
 * from the published schedule and are printed when the show starts, so pressing
 * the button is never how a show gets paid.
 *
 * What the clock is for now is the work that is *not* on the schedule — helping
 * with packing, an errand — and that has no shift to be measured against by
 * definition. Shipping was always this way.
 *
 * Kept as a named function rather than deleted at the call site so the reason
 * has somewhere to live. `showForClockIn` in the domain layer is still there and
 * still tested — it works out which show an instant belongs to, which is how
 * historical clocked entries were attributed — but nothing calls it now.
 */
export async function findShiftForClockIn(): Promise<null> {
  return null;
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

/* ==========================================================================
   Hours from the schedule.
   ========================================================================== */

/** How far back a catch-up run will reach. Older than this is history. */
const MATERIALISE_DAYS = 90;

/**
 * Writes a streamer's hours for every show that has started.
 *
 * Streamers do not clock for their shows. Being on a published schedule is the
 * commitment — if somebody is on it and it has gone out, they are working it —
 * so the hours are printed as the show begins rather than waiting for two
 * button presses that only ever reproduced the same figure, or failed to.
 *
 * Printed, and then left alone. The entry holds the show's hours as they stood
 * when it started; editing the show afterwards does not move anybody's pay. A
 * correction goes through the timesheet like any other, with a reason, keeping
 * every previous version.
 *
 * Idempotent, and safely so: a partial unique index on (userId, showId) for
 * SCHEDULE entries means two pages loading at the same moment as a show starts
 * cannot both print a copy. The duplicate is swallowed rather than raised,
 * because losing the race is the expected outcome, not a fault.
 *
 * Called on read rather than by a scheduler. There is no cron in this app, and
 * adding one to write a row that any interested page could write itself would
 * be a piece of infrastructure to keep alive for no gain.
 */
export async function materialiseScheduledHours(now: Date = new Date()): Promise<number> {
  const from = new Date(now.getTime() - MATERIALISE_DAYS * 86_400_000);

  /*
    Deliberately nothing about who the person is *now*.

    What earns the hours is being on a published schedule for a show that has
    since started. Filtering on the account as it stands today loses pay
    silently: deactivate a leaver, or move a streamer onto shipping, before
    anything has happened to load a page, and the shows they actually worked
    stop being printed and are never paid. Their assignments are deliberately
    left in place when they move (see the Team page), so the only thing that
    changed is the account — not whether they stood in front of a camera.

    Nothing else can reach this: assignments are only ever created for people
    who can be scheduled, on both the auto-fill and the copy-forward paths.
  */
  const due = await prisma.assignment.findMany({
    where: {
      show: {
        status: "SCHEDULED",
        startsAt: { gte: from, lte: now },
        release: { scheduleStatus: "PUBLISHED" },
      },
    },
    select: {
      userId: true,
      showId: true,
      show: { select: { startsAt: true, endsAt: true } },
    },
  });

  if (due.length === 0) return 0;

  const already = await prisma.timeEntry.findMany({
    where: {
      source: "SCHEDULE",
      showId: { in: due.map((d) => d.showId) },
    },
    select: { userId: true, showId: true },
  });
  const done = new Set(already.map((e) => `${e.userId}|${e.showId}`));

  const missing = due.filter((d) => !done.has(`${d.userId}|${d.showId}`));
  if (missing.length === 0) return 0;

  let written = 0;
  for (const row of missing) {
    try {
      await prisma.$transaction(async (tx) => {
        const entry = await tx.timeEntry.create({
          data: {
            userId: row.userId,
            showId: row.showId,
            clockInAt: row.show.startsAt,
            clockOutAt: row.show.endsAt,
            source: "SCHEDULE",
            version: 1,
          },
          select: { id: true },
        });
        // The first revision records the entry as originally printed, so the
        // history is complete rather than starting at the first correction.
        await tx.timeEntryRevision.create({
          data: {
            timeEntryId: entry.id,
            version: 1,
            clockInAt: row.show.startsAt,
            clockOutAt: row.show.endsAt,
            reason: "Printed from the published schedule",
            changedById: row.userId,
          },
        });
      });
      written++;
    } catch (error) {
      // Somebody else's page got there first. That is the index doing its job.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  return written;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/** How many people have already been credited for a show. */
export async function scheduledHoursPrinted(showId: string): Promise<number> {
  return prisma.timeEntry.count({ where: { showId, source: "SCHEDULE" } });
}

/** The pay period a date falls in — the same 1st–15th / 16th–end split. */
export function payPeriodFor(dateISO: DateISO): Period {
  return periodFor(dateISO);
}

export { fromDbDate };

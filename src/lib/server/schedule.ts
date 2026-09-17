import "server-only";
import { prisma } from "@/lib/db";
import { addDays, datesBetween, fromDbDate, toDbDate } from "@/lib/domain/dates";
import { periodFor } from "@/lib/domain/periods";
import type { Period } from "@/lib/domain/periods";
import { validateSchedule } from "@/lib/domain/schedule";
import type {
  AssignmentInput,
  AvailabilityInput,
  ScheduleValidation,
  ShowInput,
} from "@/lib/domain/schedule";
import type { BusinessSettings, DateISO, Platform, ShowStatus, Slot } from "@/lib/domain/types";
import { getSettings } from "./settings";
import { getPriorities, getReleaseSummary, listReleaseCast } from "./releases";
import type { ReleaseSummary } from "./releases";
import { getTimeOffByUser } from "./timeOff";
import type { TeamMember } from "./team";

export interface AssignmentView {
  id: string;
  userId: string;
  userName: string;
  /** 1 or 2, and nothing more — the pair swap jobs halfway through. */
  seat: number;
}

export interface ShowView {
  id: string;
  dateISO: DateISO;
  platform: Platform;
  slot: Slot;
  startsAt: Date;
  endsAt: Date;
  status: ShowStatus;
  notes: string | null;
  /** Wall-clock times in the business zone, for display and for edit forms. */
  startHM: string;
  endHM: string;
  minutes: number;
  /** The two people on the show, in seat order. */
  assignments: AssignmentView[];
}

export interface AvailabilityView {
  userId: string;
  userName: string;
  dateISO: DateISO;
  slot: Slot;
}

/** Who has finished answering this release. */
export interface SubmissionView {
  userId: string;
  submittedAt: Date;
}

export interface ReleaseView {
  release: ReleaseSummary;
  /** Every date the release covers, whether or not it has shows on it. */
  dates: DateISO[];
  shows: ShowView[];
  availability: AvailabilityView[];
  submissions: SubmissionView[];
  streamers: TeamMember[];
  submittedUserIds: string[];
  /** Who the boss named as priority here, best first. Empty when off. */
  priorities: { userId: string; name: string; rank: number }[];
  timeOffByUser: Record<string, DateISO[]>;
  validation: ScheduleValidation;
  settings: BusinessSettings;
}

/** Formats an instant as `HH:mm` in the business zone. */
function clockFor(timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return (date: Date) => fmt.format(date);
}

/** Everything the builder needs for one release, in one place. */
export async function getReleaseView(releaseId: string): Promise<ReleaseView | null> {
  const release = await getReleaseSummary(releaseId);
  if (!release) return null;

  const settings = await getSettings();
  const dates = datesBetween(release.startDate, release.endDate);
  const clock = clockFor(settings.timezone);

  const [showRows, availabilityRows, streamers, submissionRows, priorities] = await Promise.all([
    prisma.show.findMany({
      where: { releaseId },
      select: {
        id: true,
        date: true,
        platform: true,
        slot: true,
        startsAt: true,
        endsAt: true,
        status: true,
        notes: true,
        assignments: {
          select: { id: true, userId: true, seat: true, user: { select: { name: true } } },
          orderBy: { seat: "asc" },
        },
      },
      orderBy: [{ date: "asc" }, { startsAt: "asc" }, { platform: "asc" }],
    }),
    prisma.availability.findMany({
      where: { releaseId },
      select: { userId: true, date: true, slot: true, user: { select: { name: true } } },
    }),
    /*
      The people on this release, not every streamer.

      A diamond release that goes to two people offers those two in the seat
      picker. Nineteen names, most of whom never work this kind of show, is how
      somebody gets dropped onto the wrong one by a mis-click — and the mistake
      pays their commission out of the wrong show's sales.

      Releases made before there was a list read as everybody, so nothing that
      already exists changes. See `listReleaseCast`.
    */
    listReleaseCast(releaseId),
    prisma.availabilitySubmission.findMany({
      where: { releaseId },
      select: { userId: true, submittedAt: true },
    }),
    getPriorities(releaseId),
  ]);

  const timeOffByUser = await getTimeOffByUser({
    from: release.startDate,
    to: release.endDate,
  });

  const shows: ShowView[] = showRows.map((show) => ({
    id: show.id,
    dateISO: fromDbDate(show.date),
    platform: show.platform,
    slot: show.slot,
    startsAt: show.startsAt,
    endsAt: show.endsAt,
    status: show.status,
    notes: show.notes,
    startHM: clock(show.startsAt),
    endHM: clock(show.endsAt),
    minutes: Math.round((show.endsAt.getTime() - show.startsAt.getTime()) / 60_000),
    assignments: show.assignments.map((a) => ({
      id: a.id,
      userId: a.userId,
      userName: a.user.name,
      seat: a.seat,
    })),
  }));

  const submissions: SubmissionView[] = submissionRows.map((s) => ({
    userId: s.userId,
    submittedAt: s.submittedAt,
  }));

  // Only what people have actually sent in. Until somebody presses Send in,
  // their taps are a private draft they may still be halfway through — and a
  // half-finished list is worse than no list, because it looks like an answer.
  // Filtered here, once, so the generator, the validator and the boss's picker
  // all see the same thing rather than each remembering to check.
  const submittedIds = new Set(submissions.map((s) => s.userId));
  const availability: AvailabilityView[] = availabilityRows
    .filter((a) => submittedIds.has(a.userId))
    .map((a) => ({
      userId: a.userId,
      userName: a.user.name,
      dateISO: fromDbDate(a.date),
      slot: a.slot,
    }));

  const validation = validateSchedule(
    shows.map(toShowInput),
    shows.flatMap((s) => s.assignments.map((a) => toAssignmentInput(s.id, a))),
    {
      availability: availability.map(toAvailabilityInput),
      timeOffByUser,
      maxShowsPerPerson: release.maxShowsPerPerson,
      expectedUserIds: streamers.map((s) => s.id),
      submittedUserIds: submissions.map((s) => s.userId),
    },
  );

  return {
    release,
    dates,
    shows,
    availability,
    submissions,
    streamers,
    submittedUserIds: submissions.map((s) => s.userId),
    priorities,
    timeOffByUser,
    validation,
    settings,
  };
}

export function toShowInput(show: ShowView): ShowInput {
  return {
    id: show.id,
    dateISO: show.dateISO,
    platform: show.platform,
    slot: show.slot,
    startsAt: show.startsAt,
    endsAt: show.endsAt,
    status: show.status,
  };
}

export function toAssignmentInput(showId: string, a: AssignmentView): AssignmentInput {
  return { id: a.id, showId, userId: a.userId, userName: a.userName, seat: a.seat };
}

export function toAvailabilityInput(a: AvailabilityView): AvailabilityInput {
  return { userId: a.userId, dateISO: a.dateISO, slot: a.slot };
}

export interface EmployeeShow {
  showId: string;
  dateISO: DateISO;
  platform: Platform;
  slot: Slot;
  startsAt: Date;
  endsAt: Date;
  startHM: string;
  endHM: string;
  status: ShowStatus;
  /** The other person on the show, if there is one. */
  alongside: { name: string } | null;
}

/**
 * One person's shows for a pay period — their own, and only their own.
 *
 * Deliberately still the 1st–15th / 16th–end split, even though releases are
 * whatever length the boss picked. This is the view people read against their
 * pay, and it lines up with the clock page and the timesheet. A release that
 * straddles two pay periods simply appears in both.
 *
 * Only published releases count. A draft is the boss's working copy, and
 * showing it would have people planning around shows that may still move.
 */
export async function getEmployeePeriod(
  userId: string,
  dateISO: DateISO,
): Promise<{ period: Period; shows: EmployeeShow[]; anythingPublished: boolean }> {
  const period = periodFor(dateISO);
  const settings = await getSettings();
  const clock = clockFor(settings.timezone);

  const rows = await prisma.assignment.findMany({
    where: {
      userId,
      show: {
        date: { gte: toDbDate(period.start), lte: toDbDate(period.end) },
        release: { scheduleStatus: "PUBLISHED" },
      },
    },
    select: {
      show: {
        select: {
          id: true,
          date: true,
          platform: true,
          slot: true,
          startsAt: true,
          endsAt: true,
          status: true,
          assignments: { select: { userId: true, user: { select: { name: true } } } },
        },
      },
    },
    orderBy: { show: { startsAt: "asc" } },
  });

  // "Nothing published yet" and "published, but you are not on anything" are
  // different messages, so the page needs to tell them apart.
  const anythingPublished =
    (await prisma.show.count({
      where: {
        date: { gte: toDbDate(period.start), lte: toDbDate(period.end) },
        release: { scheduleStatus: "PUBLISHED" },
      },
    })) > 0;

  const shows: EmployeeShow[] = rows.map(({ show }) => {
    const other = show.assignments.find((a) => a.userId !== userId);
    return {
      showId: show.id,
      dateISO: fromDbDate(show.date),
      platform: show.platform,
      slot: show.slot,
      startsAt: show.startsAt,
      endsAt: show.endsAt,
      startHM: clock(show.startsAt),
      endHM: clock(show.endsAt),
      status: show.status,
      alongside: other ? { name: other.user.name } : null,
    };
  });

  return { period, shows, anythingPublished };
}

/**
 * The next shows this person is on, from now forward.
 *
 * Read by date rather than by stitching period views together. A release is
 * whatever length the boss chose and two of them can cover overlapping dates,
 * so "this period and the next" cannot be assembled from period boundaries
 * without either missing shows or listing them twice — which is exactly what
 * the dashboard used to do when a week and the week after it both fell inside
 * one half of the month.
 */
export async function getUpcomingShows(userId: string, take = 8): Promise<EmployeeShow[]> {
  const settings = await getSettings();
  const clock = clockFor(settings.timezone);

  const rows = await prisma.assignment.findMany({
    where: {
      userId,
      show: {
        status: "SCHEDULED",
        endsAt: { gte: new Date() },
        release: { scheduleStatus: "PUBLISHED" },
      },
    },
    orderBy: { show: { startsAt: "asc" } },
    take,
    select: {
      show: {
        select: {
          id: true,
          date: true,
          platform: true,
          slot: true,
          startsAt: true,
          endsAt: true,
          status: true,
          assignments: { select: { userId: true, user: { select: { name: true } } } },
        },
      },
    },
  });

  return rows.map(({ show }) => {
    const other = show.assignments.find((a) => a.userId !== userId);
    return {
      showId: show.id,
      dateISO: fromDbDate(show.date),
      platform: show.platform,
      slot: show.slot,
      startsAt: show.startsAt,
      endsAt: show.endsAt,
      startHM: clock(show.startsAt),
      endHM: clock(show.endsAt),
      status: show.status,
      alongside: other ? { name: other.user.name } : null,
    };
  });
}

/** Recently published releases, newest first — past schedules are never overwritten. */
export async function listPublishedReleases(take = 8) {
  const rows = await prisma.release.findMany({
    where: { scheduleStatus: "PUBLISHED" },
    orderBy: { startDate: "desc" },
    take,
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      version: true,
      publishedAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    startDate: fromDbDate(r.startDate),
    endDate: fromDbDate(r.endDate),
    version: r.version,
    publishedAt: r.publishedAt,
  }));
}

export { addDays };

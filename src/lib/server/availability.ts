import "server-only";
import { prisma } from "@/lib/db";
import { BUSINESS_SHORT } from "@/lib/domain/business";
import { addDays, datesBetween, fromDbDate, instantsOverlap, toDbDate } from "@/lib/domain/dates";
import { PLATFORM_SHORT, SLOT_SHORT } from "@/lib/domain/types";
import type { DateISO, Slot } from "@/lib/domain/types";
import { getSettings } from "./settings";
import type { ReleaseSummary } from "./releases";
import { getReleaseSummary, listOpenReleasesFor } from "./releases";

export interface AvailabilityPick {
  dateISO: DateISO;
  slot: Slot;
}

export interface ShowOption {
  dateISO: DateISO;
  slot: Slot;
  startHM: string;
  endHM: string;
  /** True when every show in this slot has been cancelled — nothing to offer. */
  cancelled: boolean;
  /**
   * The show this person is already working at that time on another published
   * schedule — "Diamond TikTok Day" — or null. They cannot be on both, so it is
   * not something to offer.
   */
  takenBy: string | null;
}

/**
 * Which of a release's times this person is already working on another
 * published schedule, keyed `date|slot`, with the show that has them.
 *
 * Only published schedules: somebody asked for their availability never sees a
 * draft, and a tile saying "you're on a diamond show then" for a draft would
 * tell them about a schedule that does not exist yet. The boss's builder counts
 * drafts too — see `getReleaseView`.
 *
 * A slot is taken if any of this release's shows in it overlaps the other one,
 * by real start and end times; the dates either side are read because a night
 * show crosses midnight.
 */
export async function takenElsewhere(userId: string, releaseId: string): Promise<Map<string, string>> {
  const shows = await prisma.show.findMany({
    where: { releaseId, status: "SCHEDULED" },
    select: { date: true, slot: true, startsAt: true, endsAt: true },
  });
  const taken = new Map<string, string>();
  if (shows.length === 0) return taken;

  const dates = shows.map((s) => fromDbDate(s.date)).sort();
  const mine = await prisma.assignment.findMany({
    where: {
      userId,
      show: {
        releaseId: { not: releaseId },
        status: "SCHEDULED",
        release: { scheduleStatus: "PUBLISHED" },
        date: {
          gte: toDbDate(addDays(dates[0], -1)),
          lte: toDbDate(addDays(dates[dates.length - 1], 1)),
        },
      },
    },
    select: { show: { select: { business: true, platform: true, slot: true, startsAt: true, endsAt: true } } },
  });

  for (const s of shows) {
    const other = mine.find((m) => instantsOverlap(s.startsAt, s.endsAt, m.show.startsAt, m.show.endsAt));
    if (!other) continue;
    const key = `${fromDbDate(s.date)}|${s.slot}`;
    if (!taken.has(key)) {
      taken.set(
        key,
        `${BUSINESS_SHORT[other.show.business]} ${PLATFORM_SHORT[other.show.platform]} ${SLOT_SHORT[other.show.slot]}`,
      );
    }
  }
  return taken;
}

export interface AvailabilityForRelease {
  release: ReleaseSummary;
  /** Every date the release covers, including any with no shows on them. */
  dates: DateISO[];
  /** The shows actually on offer, with the hours they will really run. */
  options: ShowOption[];
  picks: AvailabilityPick[];
  /** Set only once they have pressed Send in. Null means still a draft. */
  submittedAt: Date | null;
  /** They have sent this release in, so it is theirs no longer to change. */
  submitted: boolean;
  /** The schedule is published, so availability is now history. */
  locked: boolean;
  /** The release is out and taking answers. */
  isOpen: boolean;
  dueAt: Date | null;
  isLate: boolean;
  /** Days in this range the person cannot work at all. */
  daysOff: DateISO[];
}

/**
 * What one person is being asked for a release, and what they have said.
 *
 * The options come from the release's actual shows, so somebody is asked to
 * commit to exactly the hours that will run — not to a default fortnight that
 * may look nothing like it.
 */
export async function getAvailabilityForRelease(
  userId: string,
  releaseId: string,
): Promise<AvailabilityForRelease | null> {
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      status: true,
      scheduleStatus: true,
      dueAt: true,
    },
  });
  if (!release) return null;

  const summary = await getReleaseSummary(releaseId);
  if (!summary) return null;

  const startISO = fromDbDate(release.startDate);
  const endISO = fromDbDate(release.endDate);
  const dates = datesBetween(startISO, endISO);
  const settings = await getSettings();
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const [rows, submission, timeOff, showRows] = await Promise.all([
    prisma.availability.findMany({
      where: { userId, releaseId },
      orderBy: [{ date: "asc" }, { slot: "asc" }],
      select: { date: true, slot: true },
    }),
    prisma.availabilitySubmission.findUnique({
      where: { userId_releaseId: { userId, releaseId } },
      select: { submittedAt: true },
    }),
    prisma.timeOff.findMany({
      where: {
        userId,
        startDate: { lte: release.endDate },
        endDate: { gte: release.startDate },
      },
      select: { startDate: true, endDate: true },
    }),
    prisma.show.findMany({
      where: { releaseId },
      select: { date: true, slot: true, startsAt: true, endsAt: true, status: true },
      orderBy: [{ date: "asc" }, { startsAt: "asc" }],
    }),
  ]);

  const daysOff = dates.filter((d) =>
    timeOff.some((t) => fromDbDate(t.startDate) <= d && fromDbDate(t.endDate) >= d),
  );
  const taken = await takenElsewhere(userId, releaseId);

  // Both platforms run a slot at the same hours unless the boss changed one, so
  // a slot is described by whichever of its shows is still scheduled.
  const options: ShowOption[] = [];
  for (const date of dates) {
    for (const slot of ["DAY", "NIGHT"] as const) {
      const inSlot = showRows.filter((s) => fromDbDate(s.date) === date && s.slot === slot);
      if (inSlot.length === 0) continue;
      const live = inSlot.filter((s) => s.status === "SCHEDULED");
      const representative = live[0] ?? inSlot[0];
      options.push({
        dateISO: date,
        slot,
        startHM: clock.format(representative.startsAt),
        endHM: clock.format(representative.endsAt),
        cancelled: live.length === 0,
        takenBy: taken.get(`${date}|${slot}`) ?? null,
      });
    }
  }

  const submittedAt = submission?.submittedAt ?? null;
  const dueAt = release.dueAt;

  return {
    release: summary,
    dates,
    options,
    picks: rows.map((r) => ({ dateISO: fromDbDate(r.date), slot: r.slot })),
    submittedAt,
    submitted: submittedAt !== null,
    locked: release.scheduleStatus === "PUBLISHED",
    isOpen: release.status === "OPEN" && release.scheduleStatus !== "PUBLISHED",
    dueAt,
    isLate: dueAt !== null && submittedAt === null && dueAt.getTime() < Date.now(),
    daysOff,
  };
}

export interface OpenReleaseForUser {
  release: ReleaseSummary;
  submitted: boolean;
  /** How many shows they have tapped so far, sent in or not. */
  offered: number;
}

/**
 * The releases a streamer has actually been asked about, with where they are up
 * to on each.
 *
 * A streamer can be looking at more than one at a time — the boss may have next
 * week and the week after out together — so this is a list rather than a single
 * current period.
 */
export async function getOpenReleasesForUser(userId: string): Promise<OpenReleaseForUser[]> {
  // Shipping is never scheduled, so nothing is ever being asked of them. Checked
  // here rather than only in the pages: one forgotten guard and somebody who is
  // never on a show starts getting chased for availability.
  const person = await prisma.user.findUnique({
    where: { id: userId },
    select: { team: true, role: true },
  });
  if (!person || (person.role !== "BOSS" && person.team !== "STREAMING")) return [];

  // Only the releases this person was actually sent. The list the boss picks
  // when building a release decides who is asked — it is not a hint the seat
  // picker alone pays attention to.
  const releases = await listOpenReleasesFor(userId);
  if (releases.length === 0) return [];

  const ids = releases.map((r) => r.id);
  const [submissions, picks] = await Promise.all([
    prisma.availabilitySubmission.findMany({
      where: { userId, releaseId: { in: ids } },
      select: { releaseId: true },
    }),
    prisma.availability.groupBy({
      by: ["releaseId"],
      where: { userId, releaseId: { in: ids } },
      _count: { _all: true },
    }),
  ]);

  const submitted = new Set(submissions.map((s) => s.releaseId));
  const offered = new Map(picks.map((p) => [p.releaseId, p._count._all]));

  return releases.map((release) => ({
    release,
    submitted: submitted.has(release.id),
    offered: offered.get(release.id) ?? 0,
  }));
}

/** The release to land on: the earliest open one not yet sent in. */
export async function getDefaultRelease(userId: string): Promise<string | null> {
  const open = await getOpenReleasesForUser(userId);
  if (open.length === 0) return null;
  return (open.find((r) => !r.submitted) ?? open[0]).release.id;
}

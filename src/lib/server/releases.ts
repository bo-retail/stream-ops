import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { datesBetween, formatDateRange, fromDbDate, toDbDate } from "@/lib/domain/dates";
import type { Business } from "@/lib/domain/business";
import { askedCount, isOnRelease } from "@/lib/domain/release-members";
import type { DateISO } from "@/lib/domain/types";
import { listStreamers } from "./team";
import type { TeamMember } from "./team";

/**
 * Releases: the unit the whole app turns on.
 *
 * A release is one request for availability — the dates it covers, the shows
 * the boss put on those dates, and the rules he chose for it. Nothing is
 * inherited from a settings page, because this business has no default
 * fortnight: one week is four shows a day and the next is two.
 *
 * Payroll stays on the 1st–15th / 16th–end split regardless. A release may sit
 * inside one of those, span both, or cover three days. The two are deliberately
 * not tied together.
 */

export type ReleaseStatus = "DRAFT" | "OPEN" | "CLOSED";

export interface ReleaseSummary {
  id: string;
  /** Watches or diamonds. Chosen at creation; every show in it inherits it. */
  business: Business;
  name: string | null;
  /** "16–30 September 2026", or the name if he gave it one. */
  label: string;
  dateRange: string;
  startDate: DateISO;
  endDate: DateISO;
  days: number;
  status: ReleaseStatus;
  scheduleStatus: "DRAFT" | "PUBLISHED";
  version: number;
  dueAt: Date | null;
  releasedAt: Date | null;
  publishedAt: Date | null;
  usePriority: boolean;
  useProportional: boolean;
  maxShowsPerPerson: number | null;
  /** Live shows, seats, and how many of those seats have somebody. */
  showCount: number;
  totalSeats: number;
  filledSeats: number;
  /** Who has sent their answer in, out of who was asked. */
  submittedCount: number;
  askedCount: number;
}

/** How a release is named everywhere: his name for it, or the dates. */
export function releaseLabel(release: {
  name: string | null;
  startDate: DateISO;
  endDate: DateISO;
}): string {
  return release.name?.trim() || formatDateRange(release.startDate, release.endDate);
}

const SUMMARY_SELECT = {
  id: true,
  business: true,
  name: true,
  startDate: true,
  endDate: true,
  status: true,
  scheduleStatus: true,
  version: true,
  dueAt: true,
  releasedAt: true,
  publishedAt: true,
  usePriority: true,
  useProportional: true,
  maxShowsPerPerson: true,
} as const;

type SummaryRow = {
  id: string;
  business: Business;
  name: string | null;
  startDate: Date;
  endDate: Date;
  status: ReleaseStatus;
  scheduleStatus: "DRAFT" | "PUBLISHED";
  version: number;
  dueAt: Date | null;
  releasedAt: Date | null;
  publishedAt: Date | null;
  usePriority: boolean;
  useProportional: boolean;
  maxShowsPerPerson: number | null;
};

async function toSummaries(rows: SummaryRow[], teamSize: number): Promise<ReleaseSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [showRows, submissionCounts] = await Promise.all([
    prisma.show.groupBy({
      by: ["releaseId"],
      where: { releaseId: { in: ids }, status: "SCHEDULED" },
      _count: { _all: true },
    }),
    prisma.availabilitySubmission.groupBy({
      by: ["releaseId"],
      where: { releaseId: { in: ids } },
      _count: { _all: true },
    }),
  ]);

  // Filled seats has to count assignments on live shows only, which groupBy
  // cannot express in one go, so it is a second pass over the same ids.
  const assignmentRows = await prisma.assignment.groupBy({
    by: ["showId"],
    where: { show: { releaseId: { in: ids }, status: "SCHEDULED" } },
    _count: { _all: true },
  });
  const showToRelease = new Map(
    (
      await prisma.show.findMany({
        where: { releaseId: { in: ids }, status: "SCHEDULED" },
        select: { id: true, releaseId: true },
      })
    ).map((s) => [s.id, s.releaseId]),
  );
  const filledByRelease = new Map<string, number>();
  for (const row of assignmentRows) {
    const releaseId = showToRelease.get(row.showId);
    if (!releaseId) continue;
    filledByRelease.set(releaseId, (filledByRelease.get(releaseId) ?? 0) + row._count._all);
  }

  const showCounts = new Map(showRows.map((r) => [r.releaseId, r._count._all]));
  const submitted = new Map(submissionCounts.map((r) => [r.releaseId, r._count._all]));

  /*
    How many people each release was sent to.

    Per release, not one number for the whole team. A diamond release sent to
    two people used to read "0 of 17 answered" and stay there however many of
    the two replied, because fifteen of those seventeen were never asked.
  */
  const memberRows = await prisma.releaseMember.findMany({
    where: { releaseId: { in: ids } },
    select: { releaseId: true, userId: true },
  });
  const membersByRelease = new Map<string, string[]>();
  for (const row of memberRows) {
    membersByRelease.set(row.releaseId, [
      ...(membersByRelease.get(row.releaseId) ?? []),
      row.userId,
    ]);
  }

  return rows.map((row) => {
    const startDate = fromDbDate(row.startDate);
    const endDate = fromDbDate(row.endDate);
    const showCount = showCounts.get(row.id) ?? 0;
    return {
      id: row.id,
      business: row.business,
      name: row.name,
      label: releaseLabel({ name: row.name, startDate, endDate }),
      dateRange: formatDateRange(startDate, endDate),
      startDate,
      endDate,
      days: datesBetween(startDate, endDate).length,
      status: row.status,
      scheduleStatus: row.scheduleStatus,
      version: row.version,
      dueAt: row.dueAt,
      releasedAt: row.releasedAt,
      publishedAt: row.publishedAt,
      usePriority: row.usePriority,
      useProportional: row.useProportional,
      maxShowsPerPerson: row.maxShowsPerPerson,
      showCount,
      totalSeats: showCount * 2,
      filledSeats: filledByRelease.get(row.id) ?? 0,
      submittedCount: submitted.get(row.id) ?? 0,
      askedCount: askedCount(membersByRelease.get(row.id) ?? [], teamSize),
    };
  });
}

/**
 * How many streamers there are.
 *
 * Only the fallback for a release built before there was a list of people. What
 * a release was actually sent to is its own member rows; see `askedCount`.
 */
export const countStreamers = cache(async (): Promise<number> => {
  return prisma.user.count({
    where: { isActive: true, role: "EMPLOYEE", team: "STREAMING" },
  });
});

/** Every release, newest first. */
export async function listReleases(limit = 50): Promise<ReleaseSummary[]> {
  const [rows, asked] = await Promise.all([
    prisma.release.findMany({
      orderBy: [{ startDate: "desc" }],
      take: limit,
      select: SUMMARY_SELECT,
    }),
    countStreamers(),
  ]);
  return toSummaries(rows, asked);
}

/** One release, or null. */
export async function getReleaseSummary(releaseId: string): Promise<ReleaseSummary | null> {
  const [row, asked] = await Promise.all([
    prisma.release.findUnique({ where: { id: releaseId }, select: SUMMARY_SELECT }),
    countStreamers(),
  ]);
  if (!row) return null;
  return (await toSummaries([row], asked))[0];
}

/**
 * The releases taking answers right now — all of them, whoever they went to.
 *
 * For the admin screens. What one person has been asked about is
 * `listOpenReleasesFor`, and that is what the availability page must use.
 */
export async function listOpenReleases(): Promise<ReleaseSummary[]> {
  const [rows, asked] = await Promise.all([
    prisma.release.findMany({
      where: { status: "OPEN" },
      orderBy: [{ startDate: "asc" }],
      select: SUMMARY_SELECT,
    }),
    countStreamers(),
  ]);
  return toSummaries(rows, asked);
}

/**
 * The open releases one person has actually been asked about.
 *
 * The list the boss picks when building a release is the point of picking it: a
 * diamond release goes to the people who work diamonds and lands on nobody
 * else's page. It used to be read by the seat picker and by nothing else, so
 * sending a diamond release to two people put it in front of all seventeen
 * streamers, asking them to fill in a show they do not work.
 */
export async function listOpenReleasesFor(userId: string): Promise<ReleaseSummary[]> {
  const open = await listOpenReleases();
  if (open.length === 0) return [];

  const members = await prisma.releaseMember.findMany({
    where: { releaseId: { in: open.map((r) => r.id) } },
    select: { releaseId: true, userId: true },
  });
  const byRelease = new Map<string, string[]>();
  for (const row of members) {
    byRelease.set(row.releaseId, [...(byRelease.get(row.releaseId) ?? []), row.userId]);
  }

  return open.filter((release) => isOnRelease(byRelease.get(release.id) ?? [], userId));
}

/** Whether one person was asked about one release. */
export async function isAskedAbout(userId: string, releaseId: string): Promise<boolean> {
  return isOnRelease(await getReleaseMemberIds(releaseId), userId);
}

/**
 * Who a release is for, as a set of user ids.
 *
 * Empty means everybody. That is not a placeholder: every release created
 * before there was a list genuinely did go to the whole team, and reading it
 * that way is what lets those releases keep working untouched. A release made
 * from now on cannot be sent until somebody is chosen, so an empty set only
 * ever means "made before we chose".
 */
export async function getReleaseMemberIds(releaseId: string): Promise<string[]> {
  const rows = await prisma.releaseMember.findMany({
    where: { releaseId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/**
 * The people who may be seated on a release's shows.
 *
 * The same list, resolved to names, and with the everybody-means-everybody rule
 * applied once here rather than at each call site — the seat picker and the
 * availability chase must never disagree about who is on a release.
 */
export async function listReleaseCast(releaseId: string): Promise<TeamMember[]> {
  const [members, streamers] = await Promise.all([
    getReleaseMemberIds(releaseId),
    listStreamers(),
  ]);
  if (members.length === 0) return streamers;
  const on = new Set(members);
  return streamers.filter((s) => on.has(s.id));
}

/** Who the boss named as priority on one release, best first. */
export async function getPriorities(
  releaseId: string,
): Promise<{ userId: string; name: string; rank: number }[]> {
  const rows = await prisma.releasePriority.findMany({
    where: { releaseId },
    orderBy: [{ rank: "desc" }],
    select: { userId: true, rank: true, user: { select: { name: true } } },
  });
  return rows.map((r) => ({ userId: r.userId, name: r.user.name, rank: r.rank }));
}

/**
 * Shows that already exist on these dates, whoever put them there.
 *
 * A show is one platform and slot on one date, full stop — so two releases
 * cannot both claim the same one. Composing a release that overlaps an existing
 * one has to say which shows are already taken rather than failing on a unique
 * violation at save time.
 */
export async function takenShows(
  startISO: DateISO,
  endISO: DateISO,
  exceptReleaseId?: string,
): Promise<{ dateISO: DateISO; platform: string; slot: string; releaseId: string }[]> {
  const rows = await prisma.show.findMany({
    where: {
      date: { gte: toDbDate(startISO), lte: toDbDate(endISO) },
      ...(exceptReleaseId ? { releaseId: { not: exceptReleaseId } } : {}),
    },
    select: { date: true, platform: true, slot: true, releaseId: true },
  });
  return rows.map((r) => ({
    dateISO: fromDbDate(r.date),
    platform: r.platform,
    slot: r.slot,
    releaseId: r.releaseId,
  }));
}

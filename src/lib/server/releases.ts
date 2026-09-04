import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { datesBetween, formatDateRange, fromDbDate, toDbDate } from "@/lib/domain/dates";
import type { DateISO } from "@/lib/domain/types";

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

async function toSummaries(rows: SummaryRow[], askedCount: number): Promise<ReleaseSummary[]> {
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

  return rows.map((row) => {
    const startDate = fromDbDate(row.startDate);
    const endDate = fromDbDate(row.endDate);
    const showCount = showCounts.get(row.id) ?? 0;
    return {
      id: row.id,
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
      askedCount,
    };
  });
}

/** Everyone who gets asked: every active streamer. */
export const countAsked = cache(async (): Promise<number> => {
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
    countAsked(),
  ]);
  return toSummaries(rows, asked);
}

/** One release, or null. */
export async function getReleaseSummary(releaseId: string): Promise<ReleaseSummary | null> {
  const [row, asked] = await Promise.all([
    prisma.release.findUnique({ where: { id: releaseId }, select: SUMMARY_SELECT }),
    countAsked(),
  ]);
  if (!row) return null;
  return (await toSummaries([row], asked))[0];
}

/** The releases a streamer may answer right now. */
export async function listOpenReleases(): Promise<ReleaseSummary[]> {
  const [rows, asked] = await Promise.all([
    prisma.release.findMany({
      where: { status: "OPEN" },
      orderBy: [{ startDate: "asc" }],
      select: SUMMARY_SELECT,
    }),
    countAsked(),
  ]);
  return toSummaries(rows, asked);
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

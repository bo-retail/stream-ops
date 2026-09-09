import "server-only";
import { prisma } from "@/lib/db";
import { addDays, fromDbDate, toDbDate, todayISO } from "@/lib/domain/dates";
import type { DateISO } from "@/lib/domain/types";
import { getSettings } from "./settings";

/**
 * The show days the shipping side works from, and whether their reports arrived.
 *
 * A "show day" here is a date the schedule actually ran shows on. Shipping has
 * no schedule of its own — they pack whatever sold — so the calendar they work
 * to is the published one, read a day behind.
 */

/** How far back the day list and the missing-report banner look. */
export const LOOK_BACK_DAYS = 14;

export interface ShowDay {
  dateISO: DateISO;
  /** Shows still scheduled on that date. A fully cancelled day needs no report. */
  liveShows: number;
  report: {
    batchId: string;
    status: "OK" | "BLOCKED";
    uploadedAt: Date;
    uploadedByName: string | null;
    watchCount: number;
    boxCount: number;
    droppedCount: number;
  } | null;
  boxesTotal: number;
  boxesSent: number;
}

/**
 * Every date in the window that ran shows, newest first, with its report.
 *
 * Only published releases count. A draft is the boss's working copy and its
 * shows may still move, so asking for its sales reports would be asking about
 * a day that has not been promised to anyone.
 */
export async function listShowDays(lookBackDays = LOOK_BACK_DAYS): Promise<ShowDay[]> {
  const settings = await getSettings();
  const today = todayISO(settings.timezone);
  const from = addDays(today, -lookBackDays);

  const [shows, batches, boxes] = await Promise.all([
    // Cancelled shows are counted in too, so a day that was called off still
    // appears in the list saying so. Dropping it entirely would leave a gap
    // that reads the same as a day somebody forgot to upload.
    prisma.show.groupBy({
      by: ["date", "status"],
      where: {
        date: { gte: toDbDate(from), lte: toDbDate(today) },
        release: { scheduleStatus: "PUBLISHED" },
      },
      _count: { _all: true },
    }),
    prisma.importBatch.findMany({
      where: { showDate: { gte: toDbDate(from), lte: toDbDate(today) } },
      orderBy: { uploadedAt: "desc" },
      select: {
        id: true,
        showDate: true,
        status: true,
        uploadedAt: true,
        watchCount: true,
        boxCount: true,
        droppedCount: true,
        uploadedBy: { select: { name: true } },
      },
    }),
    prisma.package.groupBy({
      by: ["showDate", "status"],
      where: { showDate: { gte: toDbDate(from), lte: toDbDate(today) } },
      _count: { _all: true },
    }),
  ]);

  const dates = new Set<DateISO>();
  for (const row of shows) dates.add(fromDbDate(row.date));
  for (const row of batches) dates.add(fromDbDate(row.showDate));

  // Only the shows still standing count as needing a report.
  const showCount = new Map<DateISO, number>();
  for (const row of shows) {
    const key = fromDbDate(row.date);
    const running = row.status === "SCHEDULED" ? row._count._all : 0;
    showCount.set(key, (showCount.get(key) ?? 0) + running);
  }

  // The most recent upload wins; the earlier ones stay on record but are not
  // what the day currently says.
  const latest = new Map<DateISO, (typeof batches)[number]>();
  for (const batch of batches) {
    const key = fromDbDate(batch.showDate);
    if (!latest.has(key)) latest.set(key, batch);
  }

  const boxTotals = new Map<DateISO, { total: number; sent: number }>();
  for (const row of boxes) {
    const key = fromDbDate(row.showDate);
    const entry = boxTotals.get(key) ?? { total: 0, sent: 0 };
    entry.total += row._count._all;
    if (row.status !== "OPEN") entry.sent += row._count._all;
    boxTotals.set(key, entry);
  }

  return [...dates]
    .sort((a, b) => b.localeCompare(a))
    .map((dateISO) => {
      const batch = latest.get(dateISO);
      const counts = boxTotals.get(dateISO) ?? { total: 0, sent: 0 };
      return {
        dateISO,
        liveShows: showCount.get(dateISO) ?? 0,
        report: batch
          ? {
              batchId: batch.id,
              status: batch.status,
              uploadedAt: batch.uploadedAt,
              uploadedByName: batch.uploadedBy?.name ?? null,
              watchCount: batch.watchCount,
              boxCount: batch.boxCount,
              droppedCount: batch.droppedCount,
            }
          : null,
        boxesTotal: counts.total,
        boxesSent: counts.sent,
      };
    });
}

/**
 * Days that ran shows and have no report, so nothing downstream can happen.
 *
 * A day qualifies when all of these hold:
 *
 *   - it is strictly **before today** in the business zone. Today's shows have
 *     not finished, and their reports do not exist until tomorrow morning.
 *   - it has at least one **scheduled** show in a **published** release. A day
 *     whose shows were all cancelled needs no report, and a draft was never a
 *     commitment to anybody.
 *   - **no successful import** exists for it. A blocked one does not count —
 *     that is precisely the day somebody still has to deal with.
 *   - it falls inside the look-back window. Older than that is history rather
 *     than a prompt, and a banner that never clears stops being read.
 */
export async function missingReportDays(lookBackDays = LOOK_BACK_DAYS): Promise<DateISO[]> {
  const settings = await getSettings();
  const today = todayISO(settings.timezone);
  const from = addDays(today, -lookBackDays);
  // Yesterday is the newest day that can be missing anything, so the window
  // itself carries the "strictly before today" rule rather than a later filter.
  const to = addDays(today, -1);

  if (to < from) return [];

  const [shows, loaded] = await Promise.all([
    prisma.show.groupBy({
      by: ["date"],
      where: {
        date: { gte: toDbDate(from), lte: toDbDate(to) },
        status: "SCHEDULED",
        release: { scheduleStatus: "PUBLISHED" },
      },
      _count: { _all: true },
    }),
    // A refused upload is not a report — that is precisely the day somebody
    // still has to deal with — so only OK batches count as loaded.
    prisma.importBatch.findMany({
      where: { showDate: { gte: toDbDate(from), lte: toDbDate(to) }, status: "OK" },
      select: { showDate: true },
      distinct: ["showDate"],
    }),
  ]);

  const done = new Set(loaded.map((b) => fromDbDate(b.showDate)));
  return shows
    .map((s) => fromDbDate(s.date))
    .filter((d) => !done.has(d))
    .sort();
}

/**
 * The same thing, but it never throws.
 *
 * A dashboard is mostly somebody's own schedule and hours. The banner is a note
 * on top of it, and a note must not be what takes the page down: losing the
 * connection for a moment should cost the warning, not the whole screen. If the
 * database is genuinely unreachable the page's real queries will say so.
 */
export async function missingReportDaysSafe(lookBackDays = LOOK_BACK_DAYS): Promise<DateISO[]> {
  try {
    return await missingReportDays(lookBackDays);
  } catch (error) {
    console.error("Could not read the missing-report days for the banner:", error);
    return [];
  }
}

/** Yesterday, in the business zone — what the shipping screens open on. */
export async function packingDayISO(): Promise<DateISO> {
  const settings = await getSettings();
  return addDays(todayISO(settings.timezone), -1);
}

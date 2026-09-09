import "server-only";
import { prisma } from "@/lib/db";
import { addDays, fromDbDate, toDbDate, todayISO } from "@/lib/domain/dates";
import { expectedFilesFor } from "@/lib/domain/imports/expected";
import type { DayShow, ExpectedFiles } from "@/lib/domain/imports/expected";
import type { DateISO } from "@/lib/domain/types";
import { getSettings } from "./settings";

export type { DayShow, ExpectedFiles };

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
  /** Every show the schedule had that day, cancelled ones included. */
  shows: DayShow[];
  /** What the upload for this day should contain. */
  expected: ExpectedFiles;
  /** Files that actually arrived on the most recent successful upload. */
  loadedFiles: { name: string; platform: string }[];
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
    // Read as individual shows rather than counted, because what a day is
    // waiting for depends on which shows ran, not how many. Cancelled ones are
    // included so a day that was called off still appears saying so — dropping
    // it would leave a gap that reads the same as a day nobody uploaded.
    prisma.show.findMany({
      where: {
        date: { gte: toDbDate(from), lte: toDbDate(today) },
        release: { scheduleStatus: "PUBLISHED" },
      },
      select: { date: true, platform: true, slot: true, status: true },
      orderBy: [{ date: "asc" }, { platform: "asc" }, { slot: "asc" }],
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
        files: true,
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
  const showsByDate = new Map<DateISO, DayShow[]>();
  for (const row of shows) {
    const key = fromDbDate(row.date);
    dates.add(key);
    const list = showsByDate.get(key) ?? [];
    list.push({ platform: row.platform, slot: row.slot, cancelled: row.status === "CANCELLED" });
    showsByDate.set(key, list);
  }
  for (const row of batches) dates.add(fromDbDate(row.showDate));

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
      const dayShows = showsByDate.get(dateISO) ?? [];

      // `files` is written as JSON by the import, so it is read back defensively
      // rather than trusted to be the shape this version writes.
      const loadedFiles = Array.isArray(batch?.files)
        ? (batch.files as { name?: unknown; platform?: unknown }[]).map((f) => ({
            name: typeof f?.name === "string" ? f.name : "(unnamed)",
            platform: typeof f?.platform === "string" ? f.platform : "UNKNOWN",
          }))
        : [];

      return {
        dateISO,
        liveShows: dayShows.filter((s) => !s.cancelled).length,
        shows: dayShows,
        expected: expectedFilesFor(dayShows),
        loadedFiles,
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

/**
 * Undoes an upload.
 *
 * The wrong files, or the wrong day. Everything the upload created goes: the
 * sales records, the exceptions, and the boxes nobody has touched.
 *
 * It refuses outright once anybody has scanned against the day. A box that has
 * been scanned is evidence — the database itself will not let it go — and
 * removing the report underneath it would leave boxes whose contents nothing
 * explains. Undo is for a mistake noticed straight away, not a way out of a
 * morning's work.
 */
export async function deleteImport(
  batchId: string,
): Promise<{ ok: true; boxesRemoved: number } | { ok: false; reason: string }> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { id: true, showDate: true },
  });
  if (!batch) return { ok: false, reason: "That upload no longer exists." };

  const scanned = await prisma.package.count({
    where: { showDate: batch.showDate, scans: { some: {} } },
  });
  if (scanned > 0) {
    return {
      ok: false,
      reason:
        `${scanned} box${scanned === 1 ? " has" : "es have"} already been scanned against ` +
        `${fromDbDate(batch.showDate)}. Removing the report would leave them with nothing ` +
        `explaining what is in them. Upload the corrected files instead — that replaces the ` +
        `open boxes and leaves the packed ones alone.`,
    };
  }

  const removed = await prisma.$transaction(async (tx) => {
    // Boxes outlive their batch by design (the link is SET NULL), so they are
    // removed here explicitly rather than left behind with nothing behind them.
    const boxes = await tx.package.deleteMany({
      where: { showDate: batch.showDate, scans: { none: {} } },
    });
    // Sales rows and exceptions cascade from the batch.
    await tx.importBatch.delete({ where: { id: batchId } });
    return boxes.count;
  });

  return { ok: true, boxesRemoved: removed };
}

/** Yesterday, in the business zone — what the shipping screens open on. */
export async function packingDayISO(): Promise<DateISO> {
  const settings = await getSettings();
  return addDays(todayISO(settings.timezone), -1);
}

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

/** What removing a day's report would take with it. */
export interface RemovalImpact {
  dateISO: DateISO;
  batches: number;
  watches: number;
  boxes: number;
  /** Boxes somebody has already scanned. These carry the scan history. */
  scannedBoxes: number;
  /** Scan events that would be destroyed — the dispute record for that day. */
  scans: number;
}

export async function reportRemovalImpact(batchId: string): Promise<RemovalImpact | null> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { showDate: true },
  });
  if (!batch) return null;

  const showDate = batch.showDate;
  const [batches, watches, boxes, scannedBoxes, scans] = await Promise.all([
    prisma.importBatch.count({ where: { showDate } }),
    prisma.salesRecord.count({ where: { showDate } }),
    prisma.package.count({ where: { showDate } }),
    prisma.package.count({ where: { showDate, scans: { some: {} } } }),
    prisma.scanEvent.count({ where: { package: { showDate } } }),
  ]);

  return { dateISO: fromDbDate(showDate), batches, watches, boxes, scannedBoxes, scans };
}

/**
 * Removes a day's report and everything that came from it.
 *
 * The wrong files, or the wrong day. Everything for that show day goes: the
 * uploads, the sales records, the exceptions, the boxes — and, if any have been
 * packed, their scan history with them.
 *
 * That last part is the reason this asks for an explanation rather than a
 * confirmation. A scan record is the answer to a customer saying they were sent
 * the wrong watch, and once it is gone that question has no answer. The
 * database refuses to drop a scanned box on its own; getting past that is a
 * deliberate act by the owner, so it is treated like one.
 *
 * What survives is the audit line, written before the detail goes: which day,
 * how many boxes and scans, who, and why. The record of the deletion outlives
 * what was deleted.
 *
 * Where a mistake is noticed before anybody packs, uploading the corrected
 * files is still the better move — it replaces the open boxes and leaves the
 * packed ones alone. This is the way out when that is not enough.
 */
export async function deleteImport(
  batchId: string,
  reason?: string,
): Promise<{ ok: true; impact: RemovalImpact } | { ok: false; reason: string }> {
  const impact = await reportRemovalImpact(batchId);
  if (!impact) return { ok: false, reason: "That upload no longer exists." };

  const why = reason?.trim() ?? "";
  if (impact.scans > 0 && why.length < 3) {
    return {
      ok: false,
      reason:
        `${impact.scannedBoxes} box${impact.scannedBoxes === 1 ? " has" : "es have"} been packed ` +
        `against ${impact.dateISO}, and removing the report destroys ${impact.scans} scan ` +
        `record${impact.scans === 1 ? "" : "s"} with them — the answer to any dispute about those ` +
        `parcels. Say why, and it will go through.`,
    };
  }

  const showDate = toDbDate(impact.dateISO);

  await prisma.$transaction(async (tx) => {
    // In this order: scans hold a foreign key that refuses to release a packed
    // box, and boxes outlive their batch by design, so working from the outside
    // in is what leaves nothing stranded.
    await tx.scanEvent.deleteMany({ where: { package: { showDate } } });
    await tx.packageItem.deleteMany({ where: { package: { showDate } } });
    await tx.package.deleteMany({ where: { showDate } });
    // Sales rows and exceptions cascade from the batches.
    await tx.importBatch.deleteMany({ where: { showDate } });
  });

  return { ok: true, impact };
}

/** Yesterday, in the business zone — what the shipping screens open on. */
export async function packingDayISO(): Promise<DateISO> {
  const settings = await getSettings();
  return addDays(todayISO(settings.timezone), -1);
}

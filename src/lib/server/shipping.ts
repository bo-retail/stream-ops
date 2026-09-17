import "server-only";
import { prisma } from "@/lib/db";
import { addDays, fromDbDate, toDbDate, todayISO } from "@/lib/domain/dates";
import {
  expectedFilesFor,
  expectedLinesFor,
  missingExports,
  platformsOf,
} from "@/lib/domain/imports/expected";
import type { DayShow, ExpectedFiles } from "@/lib/domain/imports/expected";
import { BUSINESS_SHORT } from "@/lib/domain/business";
import type { Business } from "@/lib/domain/business";
import { PLATFORM_SHORT, SLOT_SHORT } from "@/lib/domain/types";
import type { DateISO, Platform, Slot } from "@/lib/domain/types";
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

/**
 * What one line of the checklist is called.
 *
 * Diamonds are named and watches are not, for the same reason as everywhere
 * else: watches are the great majority of every list, and labelling all of them
 * would carry no information. eBay takes no slot — its one export covers the
 * whole day however many eBay shows ran.
 */
function labelLine(business: Business, platform: Platform, slot: Slot | null): string {
  const what = `${PLATFORM_SHORT[platform]}${slot ? ` ${SLOT_SHORT[slot]}` : ""}`;
  return business === "WATCH" ? what : `${BUSINESS_SHORT[business]} ${what}`;
}

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
  /**
   * What a successful upload still lacks — "the eBay export" — or null. Null
   * too when there is no successful upload at all; `report` says that.
   */
  missing: string | null;
  report: {
    batchId: string;
    status: "OK" | "BLOCKED";
    uploadedAt: Date;
    uploadedByName: string | null;
    watchCount: number;
    boxCount: number;
    droppedCount: number;
  } | null;
  /**
   * A later upload that was turned away, when the day already had a good one.
   *
   * These are two different facts and the day has to be able to state both. The
   * report above is what the floor is packing against; this is somebody's
   * attempt to add to it that did not take. Reporting only the newer attempt —
   * which is what this used to do — made 09/16 read "Refused" with no watches
   * while 315 real boxes from the good upload sat there being packed.
   */
  refusedAfter: { batchId: string; uploadedAt: Date; uploadedByName: string | null } | null;
  /**
   * The day's upload checklist: one line per file it is waiting for, and what
   * has arrived against each.
   *
   * Built from the published schedule rather than from a list of what exists,
   * which is what makes a new kind of show work on its own. Put a diamond night
   * show on the schedule and a third TikTok line appears the moment it is
   * published — no code change, nothing to register.
   */
  checklist: ChecklistLine[];
  /**
   * Somebody took this day off the dashboard.
   *
   * It is still missing and still says so here — clearing it settles a to-do,
   * it does not load a report. Named so the page can say who decided, which is
   * the whole reason this is worth recording rather than just hiding the row.
   */
  dismissed: { byName: string | null; at: Date } | null;
  boxesTotal: number;
  boxesSent: number;
}

/** One line of a day's checklist, and whether its file has arrived. */
export interface ChecklistLine {
  label: string;
  business: Business;
  platform: Platform;
  slot: Slot | null;
  loaded: {
    batchId: string;
    fileName: string;
    uploadedAt: Date;
    uploadedByName: string | null;
    watchCount: number;
  } | null;
  /** An upload aimed at this line that was turned away. */
  refused: { batchId: string; uploadedAt: Date } | null;
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

  const [shows, batches, boxes, dismissals] = await Promise.all([
    // Read as individual shows rather than counted, because what a day is
    // waiting for depends on which shows ran, not how many. Cancelled ones are
    // included so a day that was called off still appears saying so — dropping
    // it would leave a gap that reads the same as a day nobody uploaded.
    prisma.show.findMany({
      where: {
        date: { gte: toDbDate(from), lte: toDbDate(today) },
        release: { scheduleStatus: "PUBLISHED" },
      },
      select: { date: true, business: true, platform: true, slot: true, status: true },
      orderBy: [{ date: "asc" }, { platform: "asc" }, { slot: "asc" }],
    }),
    prisma.importBatch.findMany({
      where: { showDate: { gte: toDbDate(from), lte: toDbDate(today) } },
      orderBy: { uploadedAt: "desc" },
      select: {
        id: true,
        business: true,
        platform: true,
        slot: true,
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
    prisma.dismissedReport.findMany({
      where: { showDate: { gte: toDbDate(from), lte: toDbDate(today) } },
      select: { showDate: true, dismissedAt: true, dismissedBy: { select: { name: true } } },
    }),
  ]);

  const dates = new Set<DateISO>();
  const showsByDate = new Map<DateISO, DayShow[]>();
  for (const row of shows) {
    const key = fromDbDate(row.date);
    dates.add(key);
    const list = showsByDate.get(key) ?? [];
    list.push({
      business: row.business,
      platform: row.platform,
      slot: row.slot,
      cancelled: row.status === "CANCELLED",
    });
    showsByDate.set(key, list);
  }
  for (const row of batches) dates.add(fromDbDate(row.showDate));

  /*
    What the day says, and separately what was turned away afterwards.

    The most recent *successful* upload is the day's report: it is what made the
    boxes the floor is packing and the sales payroll will read. A refused upload
    made nothing, so it cannot replace that — it can only be reported alongside.

    This used to take the newest upload whatever became of it, which is how
    09/16 came to read "Refused" with an empty watches column while 315 real
    boxes from the good upload were being scanned. The box count came from the
    boxes themselves and the watch count from the batch, so the two disagreed on
    screen with nothing wrong in the data.
  */
  /*
    The latest good upload for every LINE of every day, added together.

    A day holds one file per TikTok show and one per seller account on eBay, and
    all of them are current at once. Keeping one per day — or even one per
    business — shows only whichever went in last, and then compares that single
    file against everything the day expected and calls the day short. It read
    "missing 1 of 2 TikTok exports" with both plainly loaded.
  */
  const latestOkPerLine = new Map<DateISO, Map<string, (typeof batches)[number]>>();
  const latestAny = new Map<DateISO, (typeof batches)[number]>();
  for (const batch of batches) {
    const key = fromDbDate(batch.showDate);
    if (!latestAny.has(key)) latestAny.set(key, batch);
    if (batch.status === "OK") {
      const perLine = latestOkPerLine.get(key) ?? new Map();
      const line = `${batch.business}|${batch.platform ?? ""}|${batch.slot ?? ""}`;
      if (!perLine.has(line)) perLine.set(line, batch);
      latestOkPerLine.set(key, perLine);
    }
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
      /*
        The day's report is every kind of show's latest good upload, added up.

        A day with no successful upload at all still has to show its refused
        one — otherwise a blocked morning looks identical to one nobody has
        touched.
      */
      const newest = latestAny.get(dateISO);
      const good = [...(latestOkPerLine.get(dateISO)?.values() ?? [])].sort(
        (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
      );
      const shown = good[0] ?? newest;
      const refused =
        newest && newest.status === "BLOCKED" && shown && newest.id !== shown.id ? newest : null;

      const counts = boxTotals.get(dateISO) ?? { total: 0, sent: 0 };
      const dayShows = showsByDate.get(dateISO) ?? [];

      // `files` is written as JSON by the import, so it is read back defensively
      // rather than trusted to be the shape this version writes. Every good
      // upload's files together, because the day is waiting for all of them.
      const sourceFiles = good.length > 0 ? good : shown ? [shown] : [];
      const loadedFiles = sourceFiles.flatMap((b) =>
        Array.isArray(b.files)
          ? (b.files as { name?: unknown; platform?: unknown }[]).map((f) => ({
              name: typeof f?.name === "string" ? f.name : "(unnamed)",
              platform: typeof f?.platform === "string" ? f.platform : "UNKNOWN",
            }))
          : [],
      );

      const expected = expectedFilesFor(dayShows);
      const cleared = dismissals.find((d) => fromDbDate(d.showDate) === dateISO);

      /*
        The checklist: what the day is waiting for, and what has come in.

        Matched on the line each upload filled — business, platform and slot —
        so a file shows against its own row and nothing else. Uploads made
        before a batch knew which line it was have all three null and cannot be
        matched; those days fall back to the summary above, which is what they
        have always shown.
      */
      const dayBatches = batches.filter((b) => fromDbDate(b.showDate) === dateISO);
      const checklist: ChecklistLine[] = expectedLinesFor(dayShows, labelLine).map((line) => {
        const mine = dayBatches.filter(
          (b) =>
            b.business === line.business &&
            b.platform === line.platform &&
            (b.slot ?? null) === line.slot,
        );
        const ok = mine.find((b) => b.status === "OK");
        const newest = mine[0];
        const files = Array.isArray(ok?.files) ? (ok.files as { name?: unknown }[]) : [];

        return {
          label: line.label,
          business: line.business,
          platform: line.platform,
          slot: line.slot,
          loaded: ok
            ? {
                batchId: ok.id,
                fileName: typeof files[0]?.name === "string" ? files[0].name : "(unnamed)",
                uploadedAt: ok.uploadedAt,
                uploadedByName: ok.uploadedBy?.name ?? null,
                watchCount: ok.watchCount,
              }
            : null,
          refused:
            newest && newest.status === "BLOCKED" && newest.id !== ok?.id
              ? { batchId: newest.id, uploadedAt: newest.uploadedAt }
              : null,
        };
      });

      return {
        dateISO,
        checklist,
        dismissed: cleared
          ? { byName: cleared.dismissedBy?.name ?? null, at: cleared.dismissedAt }
          : null,
        liveShows: dayShows.filter((s) => !s.cancelled).length,
        shows: dayShows,
        expected,
        loadedFiles,
        missing:
          good.length > 0
            ? missingExports(expected, loadedFiles.map((f) => f.platform))
            : null,
        report:
          good.length > 0
            ? {
                // The newest good upload identifies the row, but the counts are
                // the day's, so a day holding both reports shows both.
                batchId: good[0].id,
                status: "OK" as const,
                uploadedAt: good[0].uploadedAt,
                uploadedByName: good[0].uploadedBy?.name ?? null,
                watchCount: good.reduce((n, b) => n + b.watchCount, 0),
                boxCount: good.reduce((n, b) => n + b.boxCount, 0),
                droppedCount: good.reduce((n, b) => n + b.droppedCount, 0),
              }
            : shown
              ? {
                  batchId: shown.id,
                  status: shown.status,
                  uploadedAt: shown.uploadedAt,
                  uploadedByName: shown.uploadedBy?.name ?? null,
                  watchCount: shown.watchCount,
                  boxCount: shown.boxCount,
                  droppedCount: shown.droppedCount,
                }
              : null,
        refusedAfter: refused
          ? {
              batchId: refused.id,
              uploadedAt: refused.uploadedAt,
              uploadedByName: refused.uploadedBy?.name ?? null,
            }
          : null,
        boxesTotal: counts.total,
        boxesSent: counts.sent,
      };
    });
}

export interface MissingReport {
  dateISO: DateISO;
  /** "no report", or what the loaded one lacks — "the eBay export". */
  missing: string;
}

/**
 * Days that ran shows and are missing some or all of their reports, so nothing
 * downstream can happen for what is missing.
 *
 * A day qualifies when all of these hold:
 *
 *   - it is strictly **before today** in the business zone. Today's shows have
 *     not finished, and their reports do not exist until tomorrow morning.
 *   - it has at least one **scheduled** show in a **published** release. A day
 *     whose shows were all cancelled needs no report, and a draft was never a
 *     commitment to anybody.
 *   - its most recent **successful** import is missing, or lacks the export of a
 *     marketplace that ran. A blocked upload does not count — that is precisely
 *     the day somebody still has to deal with — and neither does one without its
 *     eBay file, which is how 09/11 read as done while its eBay sales were not.
 *   - it falls inside the look-back window. Older than that is history rather
 *     than a prompt, and a banner that never clears stops being read.
 */
export async function missingReports(lookBackDays = LOOK_BACK_DAYS): Promise<MissingReport[]> {
  const settings = await getSettings();
  const today = todayISO(settings.timezone);
  const from = addDays(today, -lookBackDays);
  // Yesterday is the newest day that can be missing anything, so the window
  // itself carries the "strictly before today" rule rather than a later filter.
  const to = addDays(today, -1);

  if (to < from) return [];

  const [shows, loaded] = await Promise.all([
    // Individual shows rather than a count per day, because what a day is waiting
    // for depends on which marketplaces ran. Cancelled ones are left for
    // `expectedFilesFor` to discount.
    prisma.show.findMany({
      where: {
        date: { gte: toDbDate(from), lte: toDbDate(to) },
        release: { scheduleStatus: "PUBLISHED" },
      },
      select: { date: true, business: true, platform: true, slot: true, status: true },
    }),
    prisma.importBatch.findMany({
      where: { showDate: { gte: toDbDate(from), lte: toDbDate(to) }, status: "OK" },
      orderBy: { uploadedAt: "desc" },
      select: { showDate: true, business: true, platform: true, slot: true, files: true },
    }),
  ]);

  const showsByDate = new Map<DateISO, DayShow[]>();
  for (const row of shows) {
    const key = fromDbDate(row.date);
    const list = showsByDate.get(key) ?? [];
    list.push({
      business: row.business,
      platform: row.platform,
      slot: row.slot,
      cancelled: row.status === "CANCELLED",
    });
    showsByDate.set(key, list);
  }

  /*
    Every line's latest good upload, added together.

    A day is waiting for one file per TikTok show and one per seller account on
    eBay, and all of them are current at once. Keeping one per date — or one per
    business — compares a single file against everything the day expected and
    chases a day that is complete; or, worse, calls a short day done because
    another line's files happened to fill the count.
  */
  const latest = new Map<DateISO, string[]>();
  const seen = new Set<string>();
  for (const batch of loaded) {
    const key = fromDbDate(batch.showDate);
    const line = `${key}|${batch.business}|${batch.platform ?? ""}|${batch.slot ?? ""}`;
    if (seen.has(line)) continue;
    seen.add(line);
    latest.set(key, [...(latest.get(key) ?? []), ...platformsOf(batch.files)]);
  }

  /*
    Days somebody has cleared off the dashboard.

    Excluded here rather than in the component, so every caller of this banner
    agrees about what is still outstanding — including the copy of it at the top
    of Sales report entry, which is the same to-do summary and would otherwise
    keep naming days the director has already settled.

    The record of the day itself is not touched. Sales report entry's table is
    built by `listShowDays`, which goes on listing a cleared day as missing and
    says who cleared it, because that table is the account of what has actually
    been loaded rather than a list of things to do.
  */
  const cleared = new Set(
    (
      await prisma.dismissedReport.findMany({
        where: { showDate: { gte: toDbDate(from), lte: toDbDate(to) } },
        select: { showDate: true },
      })
    ).map((d) => fromDbDate(d.showDate)),
  );

  const out: MissingReport[] = [];
  for (const [dateISO, dayShows] of showsByDate) {
    if (cleared.has(dateISO)) continue;

    const expected = expectedFilesFor(dayShows);
    if (expected.tiktok === 0 && expected.ebay === 0) continue;

    const platforms = latest.get(dateISO);
    if (!platforms) {
      out.push({ dateISO, missing: "no report" });
      continue;
    }
    const missing = missingExports(expected, platforms);
    if (missing) out.push({ dateISO, missing });
  }

  return out.sort((a, b) => a.dateISO.localeCompare(b.dateISO));
}

/** Just the dates, for anything that only needs to know which days. */
export async function missingReportDays(lookBackDays = LOOK_BACK_DAYS): Promise<DateISO[]> {
  return (await missingReports(lookBackDays)).map((m) => m.dateISO);
}

/**
 * The same thing, but it never throws.
 *
 * A dashboard is mostly somebody's own schedule and hours. The banner is a note
 * on top of it, and a note must not be what takes the page down: losing the
 * connection for a moment should cost the warning, not the whole screen. If the
 * database is genuinely unreachable the page's real queries will say so.
 */
export async function missingReportsSafe(lookBackDays = LOOK_BACK_DAYS): Promise<MissingReport[]> {
  try {
    return await missingReports(lookBackDays);
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

/**
 * Yesterday, in the business zone — what the shipping screens open on.
 *
 * Re-exported rather than defined here: the box created for an unrecognised
 * label needs the same day, and two definitions of it is exactly how those
 * boxes came to be filed on a date the director never looked at.
 */
export { packingDayISO } from "./settings";

import "server-only";
import { prisma } from "@/lib/db";
import { fromDbDate, toDbDate } from "@/lib/domain/dates";
import type { DateISO } from "@/lib/domain/types";

/**
 * Which uploads a date range's sales actually come from.
 *
 * A day may legitimately be uploaded more than once — a corrected export, a
 * file that was missing first time — and every upload keeps its own sales
 * rows. Reading them all would double a re-uploaded day's revenue, in a way
 * that looks like a good week.
 *
 * So this is the one rule every sales figure in the app has to go through, and
 * it lives here rather than being written out again in each place that needs
 * it. The workbook and the insights both read from it.
 */
export async function latestBatchIds(from: DateISO, to: DateISO): Promise<string[]> {
  const batches = await prisma.importBatch.findMany({
    where: { showDate: { gte: toDbDate(from), lte: toDbDate(to) }, status: "OK" },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, showDate: true, business: true, platform: true, slot: true },
  });

  /*
    The latest upload for each line of each day's checklist.

    A day is not one report. It is one file per TikTok show and one per seller
    account on eBay, each uploaded separately, and every one of them is current
    at the same time. Keyed by day alone — or even by day and business — all but
    one would vanish from payroll, from insights and from every export, with
    nothing on screen to say they had ever been loaded.

    Superseded uploads stay on record so "what did the first one say" is still
    answerable; they are simply not what the day currently reads.
  */
  const latest = new Map<string, string>();
  for (const batch of batches) {
    const key = `${batch.business}|${fromDbDate(batch.showDate)}|${batch.platform ?? ""}|${batch.slot ?? ""}`;
    if (!latest.has(key)) latest.set(key, batch.id);
  }
  return [...latest.values()];
}

/** The earliest and latest show day anything has been loaded for. */
export async function loadedSpan(): Promise<{ first: DateISO; last: DateISO } | null> {
  const [first, last] = await Promise.all([
    prisma.importBatch.findFirst({
      where: { status: "OK" },
      orderBy: { showDate: "asc" },
      select: { showDate: true },
    }),
    prisma.importBatch.findFirst({
      where: { status: "OK" },
      orderBy: { showDate: "desc" },
      select: { showDate: true },
    }),
  ]);
  if (!first || !last) return null;
  return { first: fromDbDate(first.showDate), last: fromDbDate(last.showDate) };
}

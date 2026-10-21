/**
 * Which shows' reports a TikTok parcel may still be waiting for.
 *
 * TikTok puts everything one buyer bought before the labels are printed on one
 * label, and prints one packing slip listing all of it. A box is built from the
 * reports uploaded so far, so while one of those shows' reports is still to
 * come, the box can list fewer watches than the slip — six on the screen,
 * eleven on the slip — with nothing on the screen saying so. On 10/21 that left
 * the floor holding parcels that could never be completed.
 *
 * The reports a label can still be waiting for are the TikTok shows of its day,
 * and an early-morning show of the next, that had started before the label was
 * first seen in a report (the label already existed then, so anything sold
 * after it could not be on it), and that have no upload of their own yet. A
 * show on a draft schedule, or called off, is not one the day is waiting for.
 */
import { addDays } from "../dates";
import type { DateISO } from "../types";

export interface TikTokShowOnSchedule {
  date: DateISO;
  slot: string;
  startsAt: Date;
}

export interface ReportToCome {
  date: DateISO;
  slot: string;
}

export function reportsStillToCome({
  boxDay,
  firstSeenAt,
  shows,
  uploadedSlots,
}: {
  /** The show day the box is filed on. */
  boxDay: DateISO;
  /** When a report first named this label. Null for a label in no report. */
  firstSeenAt: Date | null;
  /** The published, not cancelled, TikTok shows of the box's business around its day. */
  shows: readonly TikTokShowOnSchedule[];
  /** The TikTok lines with a good upload, as `date|slot`. */
  uploadedSlots: ReadonlySet<string>;
}): ReportToCome[] {
  if (firstSeenAt === null) return [];
  const nextDay = addDays(boxDay, 1);
  /*
    Of the next day, only a show before its day show — an early-morning one.
    Labels are printed in the early hours; the day show starts after they are,
    even on a morning the report goes up late.
  */
  const nextDayShow = shows.find((s) => s.date === nextDay && s.slot === "DAY");
  const before = (s: TikTokShowOnSchedule) =>
    s.date === boxDay ||
    (s.slot !== "DAY" &&
      s.slot !== "NIGHT" &&
      (nextDayShow === undefined || s.startsAt.getTime() < nextDayShow.startsAt.getTime()));
  return shows
    .filter((s) => s.date === boxDay || s.date === nextDay)
    .filter(before)
    .filter((s) => s.startsAt.getTime() < firstSeenAt.getTime())
    .filter((s) => !uploadedSlots.has(`${s.date}|${s.slot}`))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map(({ date, slot }) => ({ date, slot }));
}

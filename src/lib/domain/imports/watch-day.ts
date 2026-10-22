/**
 * One watch TikTok export for several shows: a continuous stream.
 *
 * The watch shop exports one file per show, and a file is placed on one show.
 * From 10/23 the boss may run the watch TikTok as one stream from 7 AM to 1 AM,
 * while the schedule keeps its shows — early, day and night, each with its own
 * pair. TikTok then gives one export for the whole stream, and placed on one
 * show it would pay that show's pair for the whole day and the others nothing.
 *
 * So a file that runs well into more than one show is shared out by the time
 * each order was placed: an order belongs to the show that was on the schedule
 * at that minute (`showAt`). The schedule decides the edges, as it does for
 * the diamond day (Samuel, 10/12): an order at 1:00 PM is the day show's.
 *
 * What makes a file one stream rather than one show's is that it has a real
 * share of its orders well inside at least two shows — an hour clear of either
 * end of each (`showsInside`). A show's own file that started early, ran over
 * or has a stray late order stays whole on its show, exactly as before. Separate files, one per
 * show, keep working the way they always have; nothing here is a rule about
 * how the day must be streamed.
 */

import type { Slot } from "../types";
import { showAt, RUNS_INTO_NEXT_SHOW_MS } from "./extra-shows";
import type { TikTokShowWindow } from "./extra-shows";
import { defaultShiftTag, showNameFor } from "./types";
import type { WatchSale } from "./types";

const running = (shows: readonly TikTokShowWindow[]) =>
  shows.filter((s) => !s.cancelled).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

/**
 * Whether a file's orders — sold and cancelled — are one stream across several
 * of the day's shows: well inside at least two of them, an hour clear of the
 * show's start and of the next show's start.
 */
export function spansShows(times: readonly Date[], shows: readonly TikTokShowWindow[]): boolean {
  return running(shows).length >= 2 && showsInside(times, shows).length >= 2;
}

/**
 * How many orders, at least, well inside a show make a file that show's too.
 * A count, not a share of the file: a stream's quiet early show can sell a
 * twentieth of the day and still be a show of it (review 10/22).
 */
export const STREAM_MIN_ORDERS = 5;

/**
 * The shows a file runs well inside, in the day's order: at least
 * `STREAM_MIN_ORDERS` orders an hour clear of the show's start and of the
 * next show's start. A show it only touches — went live
 * early, ran over, one late order (review 10/22) — is not one of them.
 */
export function showsInside(times: readonly Date[], shows: readonly TikTokShowWindow[]): Slot[] {
  const ordered = running(shows);
  const inside = new Map<TikTokShowWindow, number>();
  for (const t of times) {
    const show = showAt(ordered, t);
    if (!show) continue;
    const next = ordered[ordered.indexOf(show) + 1];
    const from = show.startsAt.getTime() + RUNS_INTO_NEXT_SHOW_MS;
    const to = next ? next.startsAt.getTime() - RUNS_INTO_NEXT_SHOW_MS : Infinity;
    if (t.getTime() >= from && t.getTime() < to) inside.set(show, (inside.get(show) ?? 0) + 1);
  }
  return ordered.filter((s) => (inside.get(s) ?? 0) >= STREAM_MIN_ORDERS).map((s) => s.slot);
}

/** The shows a file's orders fall in, by the time each was placed, in the day's order. */
export function showsTouched(times: readonly Date[], shows: readonly TikTokShowWindow[]): Slot[] {
  const ordered = running(shows);
  const hit = new Set<TikTokShowWindow>();
  for (const t of times) {
    const show = showAt(ordered, t);
    if (show) hit.add(show);
  }
  return ordered.filter((s) => hit.has(s)).map((s) => s.slot);
}

/**
 * Each of a stream file's orders on the show that was on when it was placed.
 * An order with no readable time stays where the file was put. A show tag the
 * listing did not carry follows the show the order now belongs to.
 */
export function shareWatchStream(
  sales: readonly WatchSale[],
  file: string,
  shows: readonly TikTokShowWindow[],
): { sales: WatchSale[]; pieces: Map<Slot, number> } {
  const ordered = running(shows);
  const pieces = new Map<Slot, number>();
  const out = sales.map((s) => {
    if (s.sourceFile !== file || s.business !== "WATCH" || s.platform !== "TIKTOK" || s.createdAt === null) return s;
    const show = showAt(ordered, s.createdAt);
    if (!show) return s;
    pieces.set(show.slot, (pieces.get(show.slot) ?? 0) + (s.qty || 1));
    return {
      ...s,
      show: showNameFor("TIKTOK", show.slot),
      shiftTag: s.shiftTagValid ? s.shiftTag : defaultShiftTag(s.showDate, show.slot === "NIGHT" ? "PM" : "AM"),
    };
  });
  return { sales: out, pieces };
}

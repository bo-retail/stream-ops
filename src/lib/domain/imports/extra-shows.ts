/**
 * A TikTok file on a day with more than the day and night show.
 *
 * A TikTok export is placed on a show by its first order, and with two shows
 * that is one fixed line: before 16:00 Pacific (19:00 Eastern) is the day show,
 * after it the night (`TIKTOK_NIGHT_FROM_HOUR`). A release can now carry extra
 * shows — the boss's early morning TikTok, 7 AM to 1 PM — and a fixed line
 * cannot know about those.
 *
 * So on a day whose schedule has one, a file goes to the extra show when MOST
 * of its orders were placed in that show's hours. Not by its first order alone:
 * a day export whose stream went live at 12:20 has its first order in the early
 * show's hours and every other one after 1 PM, and placed by that one order it
 * would have replaced the early show's real file and taken its unpacked boxes
 * off the floor. Anything that is not mostly the extra show's is left exactly
 * where the parse put it, so the day and night shows are told apart the way
 * they always have been.
 *
 * On every other day nothing here happens. Every day uploaded before extra
 * shows existed reads the same as it did.
 *
 * Each show's own file is expected: the watch shop exports one per show. A file
 * that runs well into the next show is placed all the same, and said out loud,
 * because that is two shows' orders in one export and the next show's pair
 * would otherwise be paid nothing without anyone noticing.
 */

import { slotShort } from "../types";
import type { Slot } from "../types";
import type { Business } from "../business";
import { showNameFor, slotOfSalesShow } from "./types";
import type { ImportFlag, ShowKey, WatchSale } from "./types";

/** One TikTok show on the file's date. */
export interface TikTokShowWindow {
  business: Business;
  slot: Slot;
  startsAt: Date;
  endsAt: Date;
  /** Called off. Still makes the day an extra-show day; never has a file placed on it. */
  cancelled?: boolean;
}

/** How far into the next show a file may run before it is called two shows' orders. */
export const RUNS_INTO_NEXT_SHOW_MS = 60 * 60 * 1000;

const isExtra = (slot: Slot) => slot !== "DAY" && slot !== "NIGHT";

/**
 * Whether the day's TikTok shows for a business include any beyond the standard
 * two — cancelled ones included, because a file uploaded while it was on still
 * sits on its line.
 */
export function hasExtraShow(shows: readonly TikTokShowWindow[], business: Business): boolean {
  return shows.some((s) => s.business === business && isExtra(s.slot));
}

/** The running show an order placed at `t` falls in: the last to have started by then, or the day's first. */
export function showAt(shows: readonly TikTokShowWindow[], t: Date): TikTokShowWindow | null {
  const ordered = shows
    .filter((s) => !s.cancelled)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  if (ordered.length === 0) return null;
  let chosen = ordered[0];
  for (const show of ordered) if (show.startsAt.getTime() <= t.getTime()) chosen = show;
  return chosen;
}

/**
 * Files with no sale left in them — every order cancelled — placed the same
 * way: on an extra show when most of their orders, cancelled ones, fell in its
 * hours. Diamonds, and every day without an extra show, are left where the
 * parse put them. Without this, an early show's file whose orders were all
 * cancelled would go to the day show and empty the day show's line.
 */
export function placeCoversOnExtraShows<T extends { sourceFile: string; business: Business; platform: string; show: ShowKey }>(
  covers: readonly T[],
  shows: readonly TikTokShowWindow[],
  timesOf: (file: string) => Date[],
): T[] {
  return covers.map((c) => {
    if (c.platform !== "TIKTOK" || c.business === "DIAMOND" || !hasExtraShow(shows, c.business)) return c;
    const times = timesOf(c.sourceFile);
    const show = showForOrders(shows.filter((s) => s.business === c.business), times, times[0] ?? null);
    return show && isExtra(show.slot) ? { ...c, show: showNameFor("TIKTOK", show.slot) } : c;
  });
}

/**
 * The show most of a file's orders fell in, counted in pieces. A tie goes to
 * the earlier show. With no readable order time at all, the first order decides.
 */
export function showForOrders(
  shows: readonly TikTokShowWindow[],
  orderTimes: readonly Date[],
  first: Date | null,
): TikTokShowWindow | null {
  const times = orderTimes.length > 0 ? orderTimes : first ? [first] : [];
  const counts = new Map<TikTokShowWindow, number>();
  for (const t of times) {
    const show = showAt(shows, t);
    if (show) counts.set(show, (counts.get(show) ?? 0) + 1);
  }
  let best: TikTokShowWindow | null = null;
  for (const [show, n] of counts) {
    const bestN = best ? counts.get(best)! : -1;
    if (n > bestN || (n === bestN && best && show.startsAt < best.startsAt)) best = show;
  }
  return best;
}

const timeOf = (d: Date, timezone: string) =>
  d.toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });

/**
 * Re-places a business's TikTok files that are mostly an extra show's onto it.
 * Files of another business, eBay sales, files that are mostly the day or night
 * show's, and every day without an extra show come back untouched.
 *
 * `firstOrderOf` is each file's first order, cancelled or not — used only for a
 * file none of whose kept orders has a readable time.
 */
export function placeOnExtraShows(
  sales: readonly WatchSale[],
  shows: readonly TikTokShowWindow[],
  firstOrderOf: (file: string) => Date | null,
  timezone: string,
  /** Files shared out between several shows instead (`shareWatchStream`). */
  stream: ReadonlySet<string> = new Set(),
): { sales: WatchSale[]; flags: ImportFlag[] } {
  const flags: ImportFlag[] = [];
  const placed = new Map<string, ReturnType<typeof showNameFor>>();

  const files = [
    ...new Set(sales.filter((s) => s.platform === "TIKTOK").map((s) => `${s.business}|${s.sourceFile}`)),
  ];
  for (const key of files) {
    const cut = key.indexOf("|");
    const business = key.slice(0, cut) as Business;
    const file = key.slice(cut + 1);
    if (!hasExtraShow(shows, business) || stream.has(file)) continue;

    /*
      Diamonds are left as they are. The diamond shop sends the whole day as
      one file, shared between its day and night show (`shareDiamondDay`), and
      that split knows only those two. Placing such a file on an extra show
      would credit the whole day to it.
    */
    if (business === "DIAMOND") {
      flags.push({
        severity: "warning",
        message:
          `${file}: the schedule has an extra diamond TikTok show this day, and a diamond file is only ever shared ` +
          `between the diamond day and night shows. Nothing was credited to the extra show — tell your admin.`,
      });
      continue;
    }

    const mine = shows.filter((s) => s.business === business);
    const fileSales = sales.filter((s) => s.sourceFile === file && s.business === business && s.platform === "TIKTOK");
    const times = fileSales.flatMap((s) => (s.createdAt ? Array(Math.max(1, s.qty || 1)).fill(s.createdAt) : []));
    const show = showForOrders(mine, times, firstOrderOf(file));
    if (!show) continue;

    // Where the file goes: the extra show if it is mostly that show's, otherwise
    // wherever the parse put it — which for the day and night is what it always was.
    if (isExtra(show.slot)) {
      placed.set(key, showNameFor("TIKTOK", show.slot));
      flags.push({
        severity: "info",
        message: `${file}: most of its orders came in during the TikTok ${slotShort(show.slot)} show, so it is that show's file.`,
      });
    }

    /*
      Two shows' orders in one export, whichever way it went: placed by most of
      them, and said so. An order is only counted as another show's when it is
      well inside it — an hour past the next show's start, or an hour before
      this one's — so a show going live early or running over says nothing.
    */
    const running = mine
      .filter((s) => !s.cancelled)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    // Measured against the show the file is actually credited to: the extra
    // show it was moved to, or the one the parse put it on.
    const creditedSlot = isExtra(show.slot) ? show.slot : slotOfSalesShow(fileSales[0].show);
    const credited = running.find((s) => s.slot === creditedSlot);
    if (!credited) continue;
    const at = running.indexOf(credited);
    const before = at > 0 ? credited.startsAt.getTime() - RUNS_INTO_NEXT_SHOW_MS : -Infinity;
    const next = running[at + 1];
    const after = next ? next.startsAt.getTime() + RUNS_INTO_NEXT_SHOW_MS : Infinity;
    const stray = fileSales.filter(
      (s) => s.createdAt !== null && (s.createdAt.getTime() < before || s.createdAt.getTime() >= after),
    );
    if (stray.length > 0) {
      const others = [...new Set(stray.map((s) => slotShort(showAt(mine, s.createdAt!)!.slot)))];
      flags.push({
        severity: "warning",
        message:
          `${file}: ${stray.length} order(s) were placed during the TikTok ${others.join(" and ")} show, but the whole ` +
          `file was credited to the ${slotShort(credited.slot)} show (${timeOf(credited.startsAt, timezone)} start). ` +
          `If this export holds two shows' orders, export each show on its own and upload them again.`,
      });
    }
  }

  if (placed.size === 0) return { sales: [...sales], flags };
  return {
    sales: sales.map((s) => {
      const show = s.platform === "TIKTOK" ? placed.get(`${s.business}|${s.sourceFile}`) : undefined;
      return show ? { ...s, show } : s;
    }),
    flags,
  };
}

/**
 * Whether writing a TikTok file onto a line would throw away a different show's
 * file. Asked only on a day with an extra show, where a file can now land on a
 * line other than the one it always would have.
 *
 * A real correction of a line's file shares orders with it — sold or cancelled
 * since. A file sharing none is another show's export, and writing it would
 * replace that show's sales and sweep its unpacked boxes off the floor. Unless
 * those orders are already safe on another line of the day (the file was moved
 * there since), which is what a re-upload after fixing the schedule looks like.
 */
export function replacesAnotherShowsFile(
  incomingOrders: ReadonlySet<string>,
  currentOrders: readonly string[],
  ordersOnOtherLines: ReadonlySet<string>,
): boolean {
  if (currentOrders.length === 0) return false;
  if (currentOrders.some((o) => incomingOrders.has(o))) return false;
  return !currentOrders.every((o) => ordersOnOtherLines.has(o));
}

/**
 * Which kind of show an eBay export belongs to.
 *
 * A TikTok export names its own shop in `Creator Handle`, so it places itself.
 * An eBay export names no seller anywhere in its 82 columns — there is nothing
 * in the file to read. So the answer comes from the schedule instead: whoever
 * was running an eBay show that day is whose report it is.
 *
 * Which means a diamond eBay show works the day somebody publishes it. Nothing
 * here has to be edited, no shop has to be registered, no deploy has to happen.
 * The day it is on a published schedule, the system starts expecting its file
 * and knows where to put it.
 *
 * Pure, so the rule can be stated and tested on its own.
 */

import type { Business } from "../business";

/** What running an eBay show that day looks like, from the schedule. */
export interface EbayShowDay {
  business: Business;
  platform: "TIKTOK" | "EBAY";
  cancelled: boolean;
}

export type EbayPlacement =
  /** Exactly one kind of show ran eBay that day, so the file is theirs. */
  | { kind: "placed"; business: Business }
  /**
   * Both ran eBay. The file cannot say which it is and neither can the
   * schedule, so somebody has to. This is the only case that needs a person,
   * and it cannot happen until diamonds actually start selling on eBay.
   */
  | { kind: "ambiguous"; candidates: Business[] }
  /**
   * No eBay show on the schedule that day.
   *
   * Not an error: reports are often uploaded before a schedule is published, or
   * for a day somebody forgot to put on it. Watches are the answer because they
   * are the only business that has ever sold on eBay — said plainly rather than
   * assumed silently, so the flag can say so.
   */
  | { kind: "noShow"; business: Business };

export function placeEbayFile(shows: readonly EbayShowDay[]): EbayPlacement {
  const ran = [
    ...new Set(shows.filter((s) => s.platform === "EBAY" && !s.cancelled).map((s) => s.business)),
  ];

  if (ran.length === 1) return { kind: "placed", business: ran[0] };
  if (ran.length > 1) return { kind: "ambiguous", candidates: ran.sort() };
  return { kind: "noShow", business: "WATCH" };
}

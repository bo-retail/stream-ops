/**
 * Which kind of show an eBay export belongs to.
 *
 * A TikTok export names its own shop in `Creator Handle`, so it places itself.
 * An eBay export names no seller in any of its 82 columns — but it does name
 * one on the last line of the file, below the record count:
 *
 *   Seller ID : vaultshowofficial
 *
 * So there are two answers, and the file's own is the better one. The schedule
 * answers for a file whose account nobody has registered yet: whoever ran an
 * eBay show that day is whose report it is, which is enough on every day only
 * one of them did.
 *
 * Which means a diamond eBay show still works the day somebody publishes it,
 * with one exception now worth knowing: on a day when *both* ran eBay, the
 * schedule cannot choose, and the file can only choose if its account has been
 * registered in `business.ts`. That is a one-line change and a deploy.
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
   * Both ran eBay, so the schedule cannot say which this report is. Not the
   * end of it: a file naming a registered seller account still places itself.
   * This only reaches a person for a file whose account is unknown.
   *
   * It was thought this could not happen until diamonds actually sold on eBay.
   * It happened on 09/27 from a diamond eBay show that was on the schedule and
   * never sold anything, and the day's real report could not be uploaded.
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

/**
 * What is left for the schedule to answer, once each file has spoken for
 * itself.
 *
 * eBay writes `Seller ID : vaultshowofficial` on the last line of the export —
 * the same kind of evidence TikTok's `Creator Handle` gives, what the file says
 * about itself rather than what the calendar says about the day. A file naming
 * a known account needs nothing from the schedule and is placed on its own.
 *
 * This takes one account per eBay file, `null` where the account is unknown,
 * and answers only for those. Deliberately not a single answer for the whole
 * upload: one known account alongside one unknown one would otherwise place
 * both, and a diamond report would be written under watches on precisely the
 * day this exists to unblock.
 */
export type EbayFallback =
  /** Every file named an account. The schedule is not needed at all. */
  | { kind: "none" }
  /** Files without an account take this, from the schedule. */
  | { kind: "fallback"; business: Business }
  /** A file has no account and the schedule cannot choose either. */
  | { kind: "unplaceable"; candidates: Business[] };

export function ebayFallback(
  accounts: readonly (Business | null)[],
  fromSchedule: EbayPlacement,
): EbayFallback {
  if (!accounts.some((a) => a === null)) return { kind: "none" };
  if (fromSchedule.kind === "ambiguous") {
    return { kind: "unplaceable", candidates: fromSchedule.candidates };
  }
  return { kind: "fallback", business: fromSchedule.business };
}

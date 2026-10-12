/**
 * One diamond export for a day of two diamond shows.
 *
 * The watch shop exports one file per show. The diamond shop exports one file
 * for the whole day: on 10/11 its orders ran 10:33 AM to 9:42 PM, while the
 * schedule had a diamond day show and a diamond night show. A file is placed on
 * a show by its earliest order, so all of it went to the day show — the night
 * pair were credited nothing, and the day stayed "missing 1 of 4 TikTok
 * exports" for a file that was never going to come.
 *
 * So a file like that is shared out by the time each order was placed: before
 * the night show's scheduled start is the day show, from it on is the night.
 * And it is the day's diamond TikTok report as a whole — uploaded again, it
 * replaces both shows' halves, never just one (see `runImport`).
 */

import { defaultShiftTag } from "./types";
import type { WatchSale } from "./types";

/**
 * Whether a file whose last order — cancelled or not — was at `latest` covers
 * the night show. What a file covers, not what it sold: a correction whose
 * night orders were all cancelled still covers the night.
 *
 * Any order from the night show's scheduled start on is the night's. This
 * used to need an hour into the night show, to keep a day show running a few
 * minutes over with the pair who sold it. The diamond shop now always sends
 * the day as one file, and on 10/10 the night show's only two orders came at
 * 7:57 and 7:59 PM Eastern: an hour's margin gave them to the day pair and
 * left the night show "missing" for good. The schedule decides (Samuel,
 * 10/12): an order from a day show running over goes to the night pair.
 */
export function coversNight(latest: Date | null, nightStartsAt: Date): boolean {
  return latest !== null && latest.getTime() >= nightStartsAt.getTime();
}

/**
 * Each of a whole-day file's orders on the show it was placed in. With no
 * night show — called off since the file was first shared — all of it is the
 * day's. An order with no readable time stays where the file put it.
 */
export function shareDiamondDay(
  sales: readonly WatchSale[],
  file: string,
  nightStartsAt: Date | null,
): { sales: WatchSale[]; night: number } {
  let night = 0;
  const out = sales.map((s) => {
    if (s.sourceFile !== file || s.business !== "DIAMOND" || s.platform !== "TIKTOK" || s.createdAt === null) return s;
    const half = nightStartsAt !== null && s.createdAt.getTime() >= nightStartsAt.getTime() ? "PM" : "AM";
    if (half === "PM") night += s.qty || 1;
    return {
      ...s,
      show: half === "PM" ? ("TikTok PM" as const) : ("TikTok AM" as const),
      // The diamond shop's Seller SKU is no show tag, so the tag was the file's
      // own; it follows the show the order now belongs to.
      shiftTag: s.shiftTagValid ? s.shiftTag : defaultShiftTag(s.showDate, half),
    };
  });
  return { sales: out, night };
}

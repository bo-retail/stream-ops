/**
 * What a show day's upload should contain.
 *
 * The two marketplaces export on different granularities, and the difference is
 * the same one that decides how a show is identified:
 *
 *   - **TikTok exports one file per show.** Two shows, two files — which is why
 *     the file itself decides which show an order belongs to (R1).
 *   - **eBay exports one file per day**, however many shows ran, because its
 *     report cannot be filtered any finer. Which is why on eBay the shift tag
 *     has to decide the show instead (R15).
 *
 * So a day running TikTok day, TikTok night and an eBay show is waiting for
 * three files, not four — and a day running two eBay shows is still waiting for
 * one eBay file.
 */

import type { Platform, Slot } from "../types";

/** One show that ran, and therefore one thing the day's reports must account for. */
export interface DayShow {
  platform: Platform;
  slot: Slot;
  cancelled: boolean;
}

export interface ExpectedFiles {
  tiktok: number;
  ebay: number;
  /** "2 TikTok exports and 1 eBay export" — for saying out loud. */
  describe: string;
}

export function expectedFilesFor(shows: readonly DayShow[]): ExpectedFiles {
  // A cancelled show sold nothing, so it is not waiting for anything.
  const live = shows.filter((s) => !s.cancelled);

  // Counted by distinct slot rather than by show: TikTok runs one export per
  // show, and both platforms' shows share the day's slots.
  const tiktok = new Set(live.filter((s) => s.platform === "TIKTOK").map((s) => s.slot)).size;
  const ebay = live.some((s) => s.platform === "EBAY") ? 1 : 0;

  const parts: string[] = [];
  if (tiktok > 0) parts.push(`${tiktok} TikTok export${tiktok === 1 ? "" : "s"}`);
  if (ebay > 0) parts.push("1 eBay export");

  return {
    tiktok,
    ebay,
    describe: parts.length === 0 ? "nothing — no shows ran" : parts.join(" and "),
  };
}

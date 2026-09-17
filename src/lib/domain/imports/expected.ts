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

import type { Business } from "../business";
import type { Platform, Slot } from "../types";

/** One show that ran, and therefore one thing the day's reports must account for. */
export interface DayShow {
  /** Watches or diamonds. Each sells through its own seller account, so each
   *  exports its own file — see the count below. */
  business: Business;
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

/** One line of a day's upload checklist: one file, from one shop, for one show. */
export interface ExpectedLine {
  business: Business;
  platform: Platform;
  /** Null on eBay, whose one export covers the day however many shows ran. */
  slot: Slot | null;
  /** "TikTok Day", "Diamond TikTok Day", "eBay". */
  label: string;
}

/**
 * The files a day is waiting for, one line each.
 *
 * Read straight off the published schedule, which is what makes this answer
 * itself: put a diamond night show on, and the day starts expecting a third
 * TikTok export the moment it is published. Nothing here lists what exists.
 */
export function expectedLinesFor(
  shows: readonly DayShow[],
  label: (business: Business, platform: Platform, slot: Slot | null) => string,
): ExpectedLine[] {
  const live = shows.filter((s) => !s.cancelled);
  const lines = new Map<string, ExpectedLine>();

  for (const show of live) {
    // TikTok exports once per show; eBay once per day per seller account.
    const slot = show.platform === "TIKTOK" ? show.slot : null;
    const key = `${show.business}|${show.platform}|${slot ?? ""}`;
    if (lines.has(key)) continue;
    lines.set(key, {
      business: show.business,
      platform: show.platform,
      slot,
      label: label(show.business, show.platform, slot),
    });
  }

  // Watches before diamonds, TikTok before eBay, day before night — the order
  // the morning actually happens in.
  const rank = (l: ExpectedLine) =>
    `${l.business === "WATCH" ? 0 : 1}${l.platform === "TIKTOK" ? 0 : 1}${l.slot === "NIGHT" ? 1 : 0}`;
  return [...lines.values()].sort((a, b) => rank(a).localeCompare(rank(b)));
}

export function expectedFilesFor(shows: readonly DayShow[]): ExpectedFiles {
  // A cancelled show sold nothing, so it is not waiting for anything.
  const live = shows.filter((s) => !s.cancelled);

  /*
    Counted per business as well as per slot.

    TikTok exports one file per show, and each business sells through its own
    seller account — so a watch TikTok Day and a diamond TikTok Day on one date
    are two separate files, not one. Counting distinct slots alone made them one:
    a day running watch Day, watch Night, watch eBay and diamond Day would wait
    for three files when it needs four, read as complete once three arrived, and
    never chase the diamond report at all. Its sales would go unrecorded and its
    parcels would have nothing to pack against.
  */
  const tiktok = new Set(
    live.filter((s) => s.platform === "TIKTOK").map((s) => `${s.business}|${s.slot}`),
  ).size;

  // eBay exports one file per day per seller account, however many shows ran.
  const ebay = new Set(live.filter((s) => s.platform === "EBAY").map((s) => s.business)).size;

  const parts: string[] = [];
  if (tiktok > 0) parts.push(`${tiktok} TikTok export${tiktok === 1 ? "" : "s"}`);
  if (ebay > 0) parts.push(`${ebay} eBay export${ebay === 1 ? "" : "s"}`);

  return {
    tiktok,
    ebay,
    describe: parts.length === 0 ? "nothing — no shows ran" : parts.join(" and "),
  };
}

/** The marketplace each stored file was recognised as, read defensively from its JSON. */
export function platformsOf(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return (files as { platform?: unknown }[]).map((f) =>
    typeof f?.platform === "string" ? f.platform : "UNKNOWN",
  );
}

/**
 * What a loaded report is still missing, or null when it has everything.
 *
 * A day can be loaded and still have no eBay sales. 09/11 went in with its two
 * TikTok exports and no eBay one, read as done everywhere, and its eBay parcels
 * never reached the packing screen — the one eBay label somebody scanned came up
 * as "not in any report". So a day is only done when every marketplace that ran
 * is in its upload.
 */
export function missingExports(
  expected: ExpectedFiles,
  loadedPlatforms: readonly string[],
): string | null {
  const tiktok = loadedPlatforms.filter((p) => p === "TIKTOK").length;
  const ebay = loadedPlatforms.filter((p) => p === "EBAY").length;

  const parts: string[] = [];
  if (tiktok < expected.tiktok) {
    parts.push(
      tiktok === 0
        ? `the TikTok export${expected.tiktok === 1 ? "" : "s"}`
        : `${expected.tiktok - tiktok} of ${expected.tiktok} TikTok exports`,
    );
  }
  if (expected.ebay > 0 && ebay === 0) parts.push("the eBay export");

  return parts.length === 0 ? null : parts.join(" and ");
}

/**
 * Marketplaces the day's current report has that a new upload would drop.
 *
 * A new upload replaces the day's report: its sales are the ones counted, and
 * open boxes it does not mention are removed. So uploading only the missing
 * eBay file for a day that already has its TikTok exports would quietly take
 * away the TikTok sales and every unpacked TikTok box. That is refused instead.
 */
export function platformsDropped(
  previous: readonly string[],
  next: readonly string[],
): string[] {
  const now = new Set(next);
  return [...new Set(previous)].filter((p) => (p === "TIKTOK" || p === "EBAY") && !now.has(p));
}

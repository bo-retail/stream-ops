/**
 * Watches and diamonds, and the words each one uses.
 *
 * They are one company, one team, one packing table and one payroll. What makes
 * them two of anything is that they sell on separate TikTok seller accounts at
 * the same hours, so "TikTok Day on the 16th" names two different shows and
 * something on the row has to say which.
 *
 * A release chooses one when it is created; every show in it inherits it.
 *
 * Pure, like everything under `src/lib/domain` — no database, no framework. The
 * generated Prisma enum says the same thing and is deliberately not imported:
 * the vocabulary below is the app's, and the column is only where it is stored.
 */

export type Business = "WATCH" | "DIAMOND";

export const BUSINESSES: readonly Business[] = ["WATCH", "DIAMOND"] as const;

/**
 * The heading a day's shows are grouped under.
 *
 * Deliberately not a renaming of the shows themselves. "TikTok Day" is what the
 * team already calls that show and it stays called that; the heading above it
 * says whose it is. Two TikTok Days on one date are then obvious at a glance
 * without either of them growing a longer name.
 */
export const BUSINESS_LABEL: Record<Business, string> = {
  WATCH: "Watch show",
  DIAMOND: "Diamond show",
};

/** For a badge or a column, where there is no room for the full heading. */
export const BUSINESS_SHORT: Record<Business, string> = {
  WATCH: "Watch",
  DIAMOND: "Diamond",
};

/**
 * What one thing in a box is called.
 *
 * A watch is a watch. A diamond might be a loose stone, a ring or a tennis
 * bracelet, so it is a "piece" — the word that is right for all of them and
 * wrong for none.
 */
export const ITEM_WORD: Record<Business, { one: string; many: string }> = {
  WATCH: { one: "watch", many: "watches" },
  DIAMOND: { one: "piece", many: "pieces" },
};

/** "1 watch", "3 pieces". */
export function items(business: Business, n: number): string {
  const word = ITEM_WORD[business];
  return `${n} ${n === 1 ? word.one : word.many}`;
}

/* -------------------------------------------------------- reading a file */

/**
 * The TikTok shop each business sells through.
 *
 * This is how an upload is placed, and the only thing that can do it. Both
 * shows run the same hours — on 09/15 diamonds ran 10:32–16:01 Pacific against
 * the watch day show's 10:06–16:05 — so the clock separates day from night but
 * never watches from diamonds. The export names its own shop in `Creator
 * Handle`, and that is taken as the answer.
 *
 * A handle that is not here is refused rather than guessed at: a file placed on
 * the wrong show pays the wrong pair their commission, and nothing downstream
 * would ever notice. Adding a shop is a one-line change here.
 */
export const SHOP_HANDLE: Record<Business, string> = {
  WATCH: "vaultshowlive",
  DIAMOND: "caratclublive",
};

const BY_HANDLE: Record<string, Business> = Object.fromEntries(
  BUSINESSES.map((b) => [SHOP_HANDLE[b], b]),
);

/** Which business a TikTok `Creator Handle` belongs to, or null if unknown. */
export function businessOfHandle(handle: string): Business | null {
  return BY_HANDLE[handle.trim().toLowerCase()] ?? null;
}

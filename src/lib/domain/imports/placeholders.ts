/**
 * Pieces sold under a placeholder listing.
 *
 * TikTok caps a live at 100 listed items. When a show has more pieces than
 * that, the extras go up under stand-in listings — "LGD #1", "LGD #2" — and
 * after the show each one is switched to the real SKU of the piece that sold.
 * The export does not wait for the switch: on 09/15 it was downloaded 21 hours
 * after the show, labels already bought, and nine rows still read
 *
 *   LGD - As seen on screen - No returns or cancellations
 *
 * So the order says "a piece" and the piece on the table carries its own tag.
 * Nothing about the listing is printed on anything, which is what left the
 * packer with nothing to scan.
 *
 * How one is recognised: a stock number is a code, never a sentence. Across
 * every real export loaded so far — 42 diamond rows, 496 watch rows, 122 eBay
 * rows — the only "stock numbers" containing a space were those nine. That is a
 * sturdier test than the wording, which Dani writes differently from one show
 * to the next ("LGD", "LGA"), and than the Seller SKU, which on the diamond
 * shop holds a bare 1–9 on every row, real pieces included.
 *
 * Pure, like everything under `src/lib/domain`.
 */

/**
 * Whether a line's "stock number" is really a listing title.
 *
 * True means nothing on the physical piece carries it, so the packer scans the
 * piece's own tag instead and the tag is recorded against the order.
 */
export function isPlaceholderStock(stockNumber: string): boolean {
  return /\s/.test(stockNumber.trim());
}

/**
 * Whether a scan could be the tag on a piece.
 *
 * A placeholder line has no stock number to compare against, so the usual
 * "is this on a report?" test for a misread cannot run: the real tag is by
 * definition on no report. This is the check that is left. Every stock number
 * seen so far has a digit in it and no spaces — E11397, KJE7828-RD-4.00/6,
 * MPW-0396, 48395 — while the misreads on 09/10–11 included "WYZ." and a
 * shipping label. It will not catch a truncated read like "4838"; the packer
 * is shown the number she recorded so she can see one.
 */
export function looksLikeStockTag(scan: string): boolean {
  const text = scan.trim();
  return text.length >= 3 && !/\s/.test(text) && /\d/.test(text);
}

/** The scan log's note for a piece recorded against a placeholder line. */
export function placeholderNote(listing: string): string {
  return `Sold as: ${listing}`;
}

/** Which placeholder line a recorded piece belongs to, from its note. */
export function listingOfNote(note: string | null): string | null {
  if (!note?.startsWith("Sold as: ")) return null;
  return note.slice("Sold as: ".length);
}

export interface PlaceholderLine {
  stockNumber: string;
  expected: number;
  scanned: number;
}

export type PlaceholderDecision =
  /** Record the scan as the piece for this placeholder line. */
  | { kind: "fill"; listing: string }
  /** The box has no placeholder still waiting, so this is an ordinary unknown scan. */
  | { kind: "none" }
  | {
      kind: "refuse";
      reason: "notATag" | "alreadyInThisBox" | "onAnotherOrder" | "packedElsewhere";
      /** The other box involved, for the two reasons that have one. */
      otherBox?: string;
    };

/**
 * What to do with a scan that matched no line in the box.
 *
 * The placeholder fills only when every check passes, because accepting any
 * scan would switch off the one control that matters on diamonds: the wrong
 * piece going to the wrong customer.
 *
 *   notATag           It cannot be a tag — a misread.
 *   alreadyInThisBox  This piece is already recorded here. One piece, one line.
 *   onAnotherOrder    That day's report lists this exact number on somebody
 *                     else's order. The piece in her hand is theirs.
 *   packedElsewhere   This piece was already recorded as another customer's
 *                     placeholder piece that day. A piece ships once.
 *
 * Only reached when no line matched exactly, so a real stock number that is on
 * this box's own list never comes here, and a line already full keeps its own
 * "all of them are in" answer rather than spilling into the placeholder.
 */
export function decidePlaceholderScan(input: {
  scanned: string;
  lines: readonly PlaceholderLine[];
  /** Pieces already recorded against placeholder lines in this box. */
  filledHere: readonly string[];
  /** Another box that day whose report lists this number, if any. */
  onAnotherOrder: string | null;
  /** Another box that day where this piece already filled a placeholder, if any. */
  packedElsewhere: string | null;
}): PlaceholderDecision {
  const open = input.lines.find((l) => isPlaceholderStock(l.stockNumber) && l.scanned < l.expected);
  if (!open) return { kind: "none" };

  if (!looksLikeStockTag(input.scanned)) return { kind: "refuse", reason: "notATag" };
  if (input.filledHere.includes(input.scanned)) return { kind: "refuse", reason: "alreadyInThisBox" };
  if (input.onAnotherOrder) {
    return { kind: "refuse", reason: "onAnotherOrder", otherBox: input.onAnotherOrder };
  }
  if (input.packedElsewhere) {
    return { kind: "refuse", reason: "packedElsewhere", otherBox: input.packedElsewhere };
  }
  return { kind: "fill", listing: open.stockNumber };
}

/**
 * Matching a scanned USPS label to a box.
 *
 * The scanner does not return the tracking number. It returns the whole
 * Intelligent Mail package barcode, which wraps the tracking number in routing
 * data:
 *
 *   420 13057 9200190390470919012873
 *    │    │    └── the tracking number — this is what the export file holds
 *    │    └── destination ZIP, 5 digits here, 9 on some labels
 *    └── the routing application identifier
 *
 * So an exact comparison against the file fails on every single box.
 *
 * Rather than parse the prefix — which comes in at least three lengths, and is
 * absent entirely when a label is scanned from a different symbology — the scan
 * is matched by **suffix**: find the tracking number the scan ends with.
 *
 * That is only safe if no tracking number is a suffix of another. It is, and
 * provably so: every tracking number in the exports is exactly 22 digits, and
 * two distinct strings of equal length cannot be suffixes of one another. The
 * import checks this anyway (see `findSuffixCollisions`) so the day that stops
 * being true is the day we hear about it, rather than the day a packer opens
 * somebody else's box.
 */

/** Everything that is not a digit, removed. Handles spaces, dashes, stray CRs. */
export function normaliseScan(raw: string): string {
  return raw.replace(/\D+/g, "");
}

export type TrackingMatch =
  | { status: "matched"; tracking: string }
  | { status: "unknown" }
  /** Never expected — see the header note. Refused rather than guessed at. */
  | { status: "ambiguous"; candidates: string[] };

/**
 * Resolves a raw scan to one known tracking number.
 *
 * An exact hit wins outright, so a bare tracking number scanned from a
 * packing slip behaves identically to a full label.
 */
export function matchTracking(rawScan: string, known: Iterable<string>): TrackingMatch {
  const scan = normaliseScan(rawScan);
  if (scan === "") return { status: "unknown" };

  const index = new Map<string, string>();
  for (const original of known) {
    index.set(normaliseScan(original), original);
  }

  const exact = index.get(scan);
  if (exact !== undefined) return { status: "matched", tracking: exact };

  const candidates: string[] = [];
  for (const [digits, original] of index) {
    if (digits !== "" && scan.endsWith(digits)) candidates.push(original);
  }

  if (candidates.length === 1) return { status: "matched", tracking: candidates[0] };
  if (candidates.length === 0) return { status: "unknown" };
  return { status: "ambiguous", candidates };
}

/**
 * Any tracking number that is a suffix of another, which would make a scan
 * ambiguous. Run at import; expected to be empty forever.
 */
export function findSuffixCollisions(known: Iterable<string>): [string, string][] {
  const all = [...new Set([...known].map(normaliseScan))].filter((t) => t !== "");
  const collisions: [string, string][] = [];
  for (const a of all) {
    for (const b of all) {
      if (a !== b && a.endsWith(b)) collisions.push([a, b]);
    }
  }
  return collisions;
}

/**
 * The stock number a watch barcode carries, normalised for comparison.
 *
 * Case is folded because a barcode reader's output casing is not something to
 * stake a mis-pack on, and surrounding whitespace is stripped. Nothing else is
 * touched: stock numbers are a mix of digits and letters with meaningful
 * hyphens (`45874`, `9403OBXL`, `ACW8105MC-001`) and inventing further rules
 * would start matching things that are not the same watch.
 */
export function normaliseStockNumber(raw: string): string {
  return raw.trim().toUpperCase();
}

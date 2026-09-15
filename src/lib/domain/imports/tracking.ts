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
 * That is only safe if no tracking number is a suffix of another. Until
 * September 2026 it was provably so: every tracking number was 22 USPS digits,
 * and two distinct strings of equal length cannot be suffixes of one another.
 *
 * TikTok then started sending some parcels with GOFO, whose numbers are `GFUS`
 * and 14 digits (`GFUS01073044073024`). The scanner types that text exactly, and
 * with the letters dropped it is 14 digits — shorter than a USPS number, so in
 * principle it could be the tail of one. It has not been: on the 09/14 files 106
 * GOFO and 187 USPS numbers produced no collision. The import still checks every
 * day (see `findSuffixCollisions`), and a scan that could mean two boxes is
 * refused rather than guessed at, so the day that stops being true is the day we
 * hear about it, rather than the day a packer opens somebody else's box.
 */

/** Everything that is not a digit, removed. Handles spaces, dashes, stray CRs. */
export function normaliseScan(raw: string): string {
  return raw.replace(/\D+/g, "");
}

/** The carriers whose tracking numbers the exports have carried. */
export type Carrier = "USPS" | "GOFO";

/**
 * Which carrier a tracking number belongs to, by its shape. Null for a shape no
 * export has carried.
 *
 *   USPS  22 digits             9200190390470919012873
 *   GOFO  GFUS and 14 digits    GFUS01073044073024   (TikTok small parcels, from 09/14)
 */
export function trackingCarrier(tracking: string): Carrier | null {
  const t = tracking.trim().toUpperCase();
  if (/^\d{22}$/.test(t)) return "USPS";
  if (/^GFUS\d{14}$/.test(t)) return "GOFO";
  return null;
}

/**
 * Whether a scan is a shipping label rather than a watch.
 *
 * The packing screen reads the next scan as a watch while a box is open, and on
 * 09/10–11 that caused 36 of 75 refusals: the next parcel's label scanned before
 * this box was closed, or this box's own label scanned again, each one refused
 * as a watch "not in this box".
 *
 * A label is easy to tell apart. A USPS label scans as 22 to 34 digits and a GOFO
 * one as `GFUS` and 14 digits, while the longest thing on a watch is a 13-digit
 * retail barcode. Twenty digits sits clear of both, and still catches a label
 * that was only partly read.
 */
export function looksLikeShippingLabel(raw: string): boolean {
  const text = raw.trim();
  if (/^GFUS\d{14}$/i.test(text)) return true;
  return /^[\d\s-]+$/.test(text) && normaliseScan(text).length >= 20;
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

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

/**
 * The labels in one tracking cell. Usually one; sometimes two.
 *
 * An order that ships in two parcels gets two labels, and eBay writes both into
 * the same cell:
 *
 *   (9434608106244595872438,9434608106245614277593)
 *
 * Stored whole, that is a label no parcel carries: the scan is 22 digits and
 * the box is filed under 44 of them wrapped in punctuation, so neither label
 * finds it. On 09/26 that was 90 of the day's 158 parcels — the floor scanning
 * real labels and being told they were in no report at all.
 *
 * So a cell is read as the list it is. A shape nothing recognises is handed
 * back whole rather than dropped, because being unable to match it is better
 * than pretending there was no label.
 */
export function trackingLabels(raw: string): string[] {
  /*
    No upper bound on the digits.

    A ceiling truncates rather than declines: capped at 34, a 35-digit value —
    which is what an unrecognised box stores when a long scan is kept verbatim —
    came back one digit short, and a number that is not its own label cannot
    find its own box. What is left of it is a *prefix*, and the matching below
    tests suffixes, so it matches nothing at all.
  */
  const found = raw.match(/GFUS\d{14}|\d{20,}/gi) ?? [];
  if (found.length > 0) return found;
  const trimmed = raw.trim();
  return trimmed === "" ? [] : [trimmed];
}

/**
 * What to show somebody holding the parcel.
 *
 * The raw cell of a two-parcel order is unreadable on a screen, and the packer
 * only needs to recognise the one in her hand.
 */
export function describeTracking(raw: string): string {
  const labels = trackingLabels(raw);
  if (labels.length <= 1) return labels[0] ?? raw.trim();
  return `${labels[0]} +${labels.length - 1} more`;
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

  /*
    Indexed by every label a cell holds, not by the cell.

    A two-parcel order is one box wearing two labels, and whichever one is in
    her hand has to find it. Two cells sharing a label would be a box that
    cannot be told apart, so the index keeps every owner and the ambiguity is
    reported rather than resolved by whichever was read last.
  */
  const index = new Map<string, Set<string>>();
  for (const original of known) {
    for (const label of trackingLabels(original)) {
      const digits = normaliseScan(label);
      if (digits === "") continue;
      const owners = index.get(digits) ?? new Set<string>();
      owners.add(original);
      index.set(digits, owners);
    }
  }

  const decide = (owners: Set<string>): TrackingMatch =>
    owners.size === 1
      ? { status: "matched", tracking: [...owners][0] }
      : { status: "ambiguous", candidates: [...owners] };

  const exact = index.get(scan);
  if (exact !== undefined) return decide(exact);

  const candidates = new Set<string>();
  for (const [digits, owners] of index) {
    if (scan.endsWith(digits)) for (const owner of owners) candidates.add(owner);
  }

  if (candidates.size === 0) return { status: "unknown" };
  return decide(candidates);
}

/**
 * Labels that belong to more than one box.
 *
 * Its own kind of collision, and one that only exists now that a cell can hold
 * several labels: the second parcel of a two-parcel order listed alone in an
 * earlier report, or an order relabelled between two exports. A scan of that
 * label cannot say which box is meant, so it is refused — and the packer is
 * told to fetch somebody rather than left to guess. Worth knowing at import,
 * before she is standing at the table with the parcel in her hand.
 */
export function findSharedLabels(known: Iterable<string>): { label: string; owners: string[] }[] {
  const owners = new Map<string, Set<string>>();
  for (const cell of known) {
    for (const label of trackingLabels(cell)) {
      const digits = normaliseScan(label);
      if (digits === "") continue;
      const set = owners.get(digits) ?? new Set<string>();
      set.add(cell);
      owners.set(digits, set);
    }
  }
  return [...owners]
    .filter(([, cells]) => cells.size > 1)
    .map(([label, cells]) => ({ label, owners: [...cells] }));
}

/**
 * Any tracking number that is a suffix of another, which would make a scan
 * ambiguous. Run at import; expected to be empty forever.
 */
export function findSuffixCollisions(known: Iterable<string>): [string, string][] {
  const labels = [...known].flatMap(trackingLabels);
  const all = [...new Set(labels.map(normaliseScan))].filter((t) => t !== "");
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

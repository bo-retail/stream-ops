/**
 * Inventory, step 1: the catalogue and counting.
 *
 * Pure, like everything under `src/lib/domain`: the rules for reading a model
 * number, a counted quantity and a master-file row, and for turning a count
 * into stock lines. The database and the pages are elsewhere.
 *
 * Kept deliberately small. Stock is a list of changes per model and place; a
 * place's stock is the sum of them. A count says "there are N here", so it
 * writes the difference between N and what the app thought.
 */
import { storableLink } from "./watch-images";

/** Where a watch physically is, in the order the team reads them. */
export const PLACES = ["SELLABLE", "SAMPLE_EBAY", "SAMPLE_TIKTOK", "RANDOM_PULLS", "DAMAGED"] as const;
export type Place = (typeof PLACES)[number];

/**
 * Sold and paid for, still in the building until its box is sent. Not one of
 * the {@link PLACES}: nobody counts it, a sale fills it and packing empties it.
 */
export const WAITING = "WAITING" as const;
export type Where = Place | typeof WAITING;

export const PLACE_LABEL: Record<Where, string> = {
  SELLABLE: "Sellable",
  SAMPLE_EBAY: "Sample eBay",
  SAMPLE_TIKTOK: "Sample TikTok",
  RANDOM_PULLS: "Random pulls",
  DAMAGED: "Damaged",
  WAITING: "Sold, waiting to ship",
};

/**
 * A model number as the scanner and the reports read it.
 *
 * Trimmed and upper-cased, and nothing else: model numbers mix digits, letters
 * and meaningful hyphens ("49888", "TM-525003", "ACW8082-014"). A number Excel
 * stored as a number comes back as one, so it is turned into text first.
 */
export function normaliseModel(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim().toUpperCase();
}

export type QtyResult = { kind: "blank" } | { kind: "ok"; qty: number } | { kind: "bad"; why: string };

/**
 * A counted quantity, as typed or as a spreadsheet cell.
 *
 * Blank means "not counted", which leaves that place as it is. Zero means
 * "counted, and there are none". Anything that is not a whole number of zero
 * or more is refused rather than guessed at.
 */
export function parseQty(raw: unknown): QtyResult {
  if (raw === null || raw === undefined) return { kind: "blank" };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
      return { kind: "bad", why: `${raw} is not a whole number of watches` };
    }
    return { kind: "ok", qty: raw };
  }
  const text = String(raw).trim().replace(/,/g, "");
  if (text === "") return { kind: "blank" };
  if (!/^\d+(\.0+)?$/.test(text)) return { kind: "bad", why: `"${String(raw).trim()}" is not a whole number of watches` };
  return { kind: "ok", qty: Math.round(Number(text)) };
}

/** Dollars from a cell ("58", 58, "$58.00") to cents. Null when empty or not money. */
export function parseMoney(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim().replace(/[$,\s]/g, ""));
  if (String(raw).trim() === "" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** A plain number (weight, inches) from a cell. Null when empty or not a number. */
export function parseNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/* ------------------------------------------------------------ the master */

/** The details a master-file row can give a model. Empty strings and nulls mean "not given". */
export interface ProductDetails {
  model: string;
  brand: string;
  collection: string;
  series: string;
  gender: string;
  description: string;
  imageUrl: string;
  costCents: number | null;
  tpCents: number | null;
  msrpCents: number | null;
  weightLb: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  ebayShippingProfile: string;
}

const positive = (cents: number | null) => (cents !== null && cents > 0 ? cents : null);

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

/**
 * One row of Invicta's master file, read by its column headings.
 *
 * Headings are matched loosely (case and spacing), because the file is edited
 * by hand and the same column has been "URL" and "Small Main Image". Null for a
 * row with no model number — a blank or a totals row.
 */
export function detailsFromMasterRow(row: Record<string, unknown>): ProductDetails | null {
  const get = (...names: string[]) => {
    for (const name of names) {
      const key = Object.keys(row).find((k) => k.trim().toLowerCase() === name.toLowerCase());
      if (key !== undefined && text(row[key]) !== "") return row[key];
    }
    return null;
  };
  const model = normaliseModel(get("Invicta Model", "Model"));
  if (model === "") return null;
  return {
    model,
    brand: text(get("Brand")),
    collection: text(get("Collection")),
    series: text(get("Series")),
    gender: text(get("Gender")),
    description: text(get("Description")),
    // Anything that is not a web address (#N/A, a note) counts as blank, so it
    // never replaces a good picture already there.
    imageUrl: storableLink(text(get("URL", "Image URL", "Small Main Image"))),
    // The master writes 0 where it has no figure (TP is a formula of a cost of 0),
    // so 0 is read as "not given", never as a price of nothing.
    costCents: positive(parseMoney(get("Cost"))),
    tpCents: positive(parseMoney(get("TP"))),
    msrpCents: positive(parseMoney(get("MSRP"))),
    weightLb: parseNumber(get("Package weight(lb)", "Weight (lb)")),
    lengthIn: parseNumber(get("Package length(inch)", "Length (in)")),
    widthIn: parseNumber(get("Package width(inch)", "Width (in)")),
    heightIn: parseNumber(get("Package height(inch)", "Height (in)")),
    ebayShippingProfile: text(get("eBay Shipping Profile Name", "eBay shipping profile")),
  };
}

/**
 * What loading the master changes on a model already in the catalogue.
 *
 * Details the master gives replace what is there. Cost is the exception: the
 * master fills a missing cost but never changes one, because a cost already
 * set came from a real shipment and only a cost correction moves it. A cost of
 * zero in the master is treated as no cost — the master shows 0 for models
 * that have none. Returns only the fields that actually change.
 */
export function masterChanges(
  current: Omit<ProductDetails, "model">,
  incoming: ProductDetails,
  typed: readonly string[] = [],
): Partial<Omit<ProductDetails, "model">> {
  const changes: Partial<Omit<ProductDetails, "model">> = {};
  // What the team typed in the app wins over the master (Samuel, 1 October).
  const ours = new Set(typed);
  const fields = [
    "brand", "collection", "series", "gender", "description", "imageUrl", "ebayShippingProfile",
  ] as const;
  for (const f of fields) {
    if (incoming[f] !== "" && incoming[f] !== current[f] && !ours.has(f)) changes[f] = incoming[f];
  }
  const numbers = ["tpCents", "msrpCents", "weightLb", "lengthIn", "widthIn", "heightIn"] as const;
  for (const f of numbers) {
    if (incoming[f] !== null && incoming[f] !== current[f] && !ours.has(f)) changes[f] = incoming[f];
  }
  if (current.costCents === null && incoming.costCents !== null && incoming.costCents > 0) {
    changes.costCents = incoming.costCents;
  }
  return changes;
}

/* ------------------------------------------------------------- counting */

/** What one model's count says, per place. A place left out was not counted. */
export type CountedPlaces = Partial<Record<Place, number>>;

/**
 * The stock lines a count writes: for each place counted, the difference
 * between what was counted and what the app had. A place that matched still
 * gets a line of 0, so the history shows it was counted.
 */
export function countLines(
  current: Partial<Record<Place, number>>,
  counted: CountedPlaces,
): { place: Place; qty: number; counted: number }[] {
  return PLACES.filter((p) => counted[p] !== undefined).map((place) => ({
    place,
    counted: counted[place]!,
    qty: counted[place]! - (current[place] ?? 0),
  }));
}

/**
 * Why a new model number is not acceptable, or null when it is.
 *
 * Only for adding a model, which can never be undone (its history is kept for
 * good). Catches what Excel and tired fingers produce: a totals row, a number
 * turned into 4.9888E+4, a label with spaces, a cell with no digits at all.
 */
export function badModelNumber(model: string): string | null {
  if (model === "") return "there is no model number";
  if (model.length > 40) return `"${model}" is too long to be a model number`;
  if (/\s/.test(model)) return `"${model}" has a space in it`;
  if (/^\d+(\.\d+)?E[+-]?\d+$/i.test(model)) return `"${model}" is a number Excel changed — type it as text`;
  if (!/\d/.test(model)) return `"${model}" has no digits — is it a model number?`;
  if (!/^[A-Z0-9][A-Z0-9\-./]*$/.test(model)) return `"${model}" has characters a model number does not`;
  return null;
}

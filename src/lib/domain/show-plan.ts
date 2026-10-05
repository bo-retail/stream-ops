/**
 * Inventory, step 5: the day's plan — what goes on eBay at each show, and the
 * rest on TikTok — and the rows of the upload files it produces.
 *
 * How the day works (Samuel, 4 October):
 *  - Both shows are planned in the morning, together. The sales reports arrive
 *    the next morning, so nothing sold in the AM show is known before the PM
 *    show. A unit can therefore be on one show only: AM eBay, PM eBay or
 *    TikTok, never two.
 *  - eBay takes at most 750 units a show, one unit a listing, one file a show.
 *  - TikTok is one upload a day, shared by both shows (what the AM does not
 *    sell stays up for the PM), carrying everything not on either eBay file.
 *  - A watch runs at a $1 start, or at a set price (an auction starting at its
 *    target price) — by default when its TP is over $120. Same on both.
 *  - Every eBay listing ends with its show; an unsold watch is simply
 *    available again the next morning.
 *
 * Pure, like everything under `src/lib/domain`. The plan never moves stock.
 */
import type { DateISO } from "./types";

export const EBAY_CAP = 750;
/** A TP over this runs at a set price unless someone says otherwise. */
export const SET_PRICE_ABOVE_CENTS = 12_000;
/** TikTok's fixed price until a model has an MSRP: then it is half the MSRP. */
export const TIKTOK_PRICE_FALLBACK_CENTS = 80_000;

export const SHOWS = ["AM", "PM"] as const;
export type Show = (typeof SHOWS)[number];

/** What the files need to know about a model. */
export interface PlanProduct {
  model: string;
  description: string;
  /** The picture link the platforms fetch. An uploaded photo has none. */
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

/** A model with sellable stock this morning. */
export interface PlanCandidate extends PlanProduct {
  /** Sellable now: what is on the shelf, sold-and-waiting already taken off. */
  available: number;
  /** Units sold over the last seven days, both platforms. */
  soldLast7: number;
}

/** What the team decides per model. */
export interface PlanChoice {
  model: string;
  AM: number;
  PM: number;
  setPrice: boolean;
}

/** One model in the day's plan, TikTok worked out. */
export interface PlanLine extends PlanChoice {
  tiktok: number;
}

const has = (n: number | null) => n !== null && n > 0;

/** What a model lacks before it can go on eBay; empty when it is ready. */
export function missingForEbay(p: PlanProduct): string[] {
  const out: string[] = [];
  if (p.description.trim() === "") out.push("description");
  if (p.imageUrl.trim() === "") out.push("picture link");
  if (p.ebayShippingProfile.trim() === "") out.push("eBay shipping profile");
  return out;
}

/** What a model lacks before it can go on TikTok; empty when it is ready. */
export function missingForTiktok(p: PlanProduct): string[] {
  const out: string[] = [];
  if (p.description.trim() === "") out.push("description");
  if (p.imageUrl.trim() === "") out.push("picture link");
  if (!has(p.weightLb)) out.push("weight");
  if (!has(p.lengthIn) || !has(p.widthIn) || !has(p.heightIn)) out.push("box size");
  return out;
}

export function defaultSetPrice(tpCents: number | null): boolean {
  return tpCents !== null && tpCents > SET_PRICE_ABOVE_CENTS;
}

/** Margin at target price, or null when TP or cost is missing. */
export function marginAtTp(p: Pick<PlanProduct, "tpCents" | "costCents">): number | null {
  if (!p.tpCents || p.costCents === null) return null;
  return (p.tpCents - p.costCents) / p.tpCents;
}

/**
 * How much a model deserves an eBay slot: margin at target price times how
 * well it has been selling (1 + units sold in the last seven days). A model
 * with no margin figure still gets a small share, so a new watch is tried.
 */
export function score(c: PlanCandidate): number {
  return Math.max(0.05, marginAtTp(c) ?? 0) * (1 + Math.max(0, c.soldLast7));
}

/**
 * The suggested eBay picks for the day.
 *
 * The 750 a show are shared out in proportion to {@link score}, never more
 * than half a model's units (rounded up, so a single watch can still go), the
 * rest left to TikTok. Each model's eBay units are then split between the two
 * shows as evenly as possible, so both shows get the good watches. A show that
 * is not on the schedule gets nothing.
 */
export function propose(
  candidates: PlanCandidate[],
  shows: Record<Show, boolean>,
  cap = EBAY_CAP,
): Map<string, { AM: number; PM: number }> {
  const out = new Map<string, { AM: number; PM: number }>();
  const slots = SHOWS.filter((s) => shows[s]);
  if (slots.length === 0) return out;

  const pool = candidates
    .filter((c) => c.available > 0 && missingForEbay(c).length === 0)
    .map((c) => ({ model: c.model, max: Math.ceil(c.available / 2), given: 0, score: score(c) }))
    .sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));

  let remaining = cap * slots.length;
  for (let pass = 0; pass < 100 && remaining > 0; pass++) {
    const open = pool.filter((p) => p.given < p.max);
    if (open.length === 0) break;
    const total = open.reduce((n, p) => n + p.score, 0);
    const budget = remaining;
    let given = 0;
    for (const p of open) {
      const g = Math.min(p.max - p.given, Math.floor((budget * p.score) / total));
      p.given += g;
      given += g;
    }
    remaining -= given;
    if (given === 0) {
      // Shares too small to round up to a unit: one each, best first.
      for (const p of open) {
        if (remaining <= 0) break;
        p.given++;
        remaining--;
      }
    }
  }

  const picked = pool.filter((p) => p.given > 0);
  if (slots.length === 1) {
    for (const p of picked) out.set(p.model, { AM: slots[0] === "AM" ? p.given : 0, PM: slots[0] === "PM" ? p.given : 0 });
    return out;
  }
  for (const p of picked) out.set(p.model, { AM: Math.ceil(p.given / 2), PM: Math.floor(p.given / 2) });
  // An odd number goes to the AM; if that tips the AM over its cap, the odd
  // ones move to the PM, weakest first (the total never exceeds both caps).
  let am = [...out.values()].reduce((n, v) => n + v.AM, 0);
  let pm = [...out.values()].reduce((n, v) => n + v.PM, 0);
  for (const p of [...picked].reverse()) {
    if (am <= cap) break;
    const v = out.get(p.model)!;
    if (v.AM > v.PM && pm < cap) {
      v.AM--;
      v.PM++;
      am--;
      pm++;
    }
  }
  return out;
}

/**
 * Checks the team's choices against this morning's stock and works out
 * TikTok. Every candidate gets a line; a model not chosen is all TikTok (if it
 * is ready for TikTok — otherwise it stays on the shelf, held).
 */
export function checkPlan(
  choices: PlanChoice[],
  candidates: PlanCandidate[],
  cap = EBAY_CAP,
  issued: Issued = {},
): { lines: PlanLine[]; problems: string[] } {
  const problems: string[] = [];
  const out = (file: FileKey, model: string) => issued[file]?.[model] ?? 0;
  const byModel = new Map(candidates.map((c) => [c.model, c]));
  const chosen = new Map<string, PlanChoice>();
  for (const ch of choices) {
    const c = byModel.get(ch.model);
    if (chosen.has(ch.model)) {
      problems.push(`${ch.model} is in the plan twice.`);
      continue;
    }
    if (!c) {
      if (ch.AM > 0 || ch.PM > 0) problems.push(`${ch.model}: none on the shelf this morning.`);
      continue;
    }
    if (![ch.AM, ch.PM].every((n) => Number.isInteger(n) && n >= 0)) {
      problems.push(`${ch.model}: eBay numbers must be whole numbers of 0 or more.`);
      continue;
    }
    if (ch.setPrice && !c.tpCents) problems.push(`${ch.model} has no target price, so it cannot run at a set price.`);
    // A file already downloaded may be on the platform: its numbers stay, and
    // are not checked again (if the shelf has dropped below them since, the
    // page says what to take down by hand). Only the units still free are
    // checked against what is left of the shelf.
    for (const show of SHOWS) {
      if (issued[show] && ch[show] !== out(show, ch.model)) {
        problems.push(`${ch.model}: the ${show} eBay file is already out with ${out(show, ch.model)}, so that number cannot change now.`);
      }
    }
    const fixed = FILE_KEYS.reduce((n, f) => n + (issued[f] ? out(f, ch.model) : 0), 0);
    const room = Math.max(0, c.available - fixed);
    const free = SHOWS.reduce((n, show) => n + (issued[show] ? 0 : ch[show]), 0);
    if (free > room) {
      problems.push(
        fixed > 0
          ? `${ch.model}: ${free} more on eBay, but only ${room} of the ${c.available} on the shelf are not in a file already out.`
          : `${ch.model}: ${free} on eBay, but only ${c.available} on the shelf. A watch can be on one show only.`,
      );
    }
    const missing = missingForEbay(c);
    if (free > 0 && missing.length > 0) problems.push(`${ch.model} cannot go on eBay without its ${missing.join(", ")}.`);
    chosen.set(ch.model, ch);
  }

  const lines = candidates.map((c): PlanLine => {
    const ch = chosen.get(c.model) ?? { model: c.model, AM: 0, PM: 0, setPrice: defaultSetPrice(c.tpCents) };
    const left = Math.max(0, c.available - ch.AM - ch.PM);
    const tiktok = issued.tiktok ? out("tiktok", c.model) : missingForTiktok(c).length === 0 ? left : 0;
    return { model: c.model, AM: ch.AM, PM: ch.PM, setPrice: ch.setPrice, tiktok };
  });
  for (const show of SHOWS) {
    const n = lines.reduce((t, l) => t + l[show], 0);
    if (n > cap) problems.push(`${show} eBay has ${n} units; eBay takes at most ${cap} a show.`);
  }
  return { lines, problems };
}

/** The day's three files. */
export type FileKey = Show | "tiktok";
export const FILE_KEYS: readonly FileKey[] = ["AM", "PM", "tiktok"];

/**
 * What each file already downloaded carried, per model. A downloaded file may
 * already be on eBay or TikTok, so what it listed is fixed: later changes can
 * only come out of the files not yet downloaded.
 */
export type Issued = Partial<Record<FileKey, Record<string, number>>>;

/**
 * A saved plan laid over this morning's stock, for the files.
 *
 * Stock can change after the plan was saved — yesterday's report uploaded
 * late, a watch moved to damaged. Nothing is listed that is not there: the
 * files already downloaded keep what they had, and what is left of the shelf
 * goes to the others — a model short of its planned eBay units loses them from
 * the PM first, then the AM, and a model no longer ready for eBay comes off
 * it. TikTok, until its file is out, is what is left. Every cut is reported,
 * and so is any model the files already out list more of than there is: that
 * has to be taken down by hand on the platform.
 */
export function fitToStock(
  saved: PlanChoice[],
  candidates: PlanCandidate[],
  issued: Issued = {},
): { lines: PlanLine[]; cuts: string[]; overListed: string[] } {
  const cuts: string[] = [];
  const overListed: string[] = [];
  const byModel = new Map(saved.map((s) => [s.model, s]));
  const here = new Set(candidates.map((c) => c.model));
  const out = (file: FileKey, model: string) => issued[file]?.[model] ?? 0;
  const outTotal = (model: string) => FILE_KEYS.reduce((n, f) => n + (issued[f] ? out(f, model) : 0), 0);
  const where = (model: string) =>
    FILE_KEYS.filter((f) => issued[f] && out(f, model) > 0).map((f) => `${f === "tiktok" ? "TikTok" : `${f} eBay`} ${out(f, model)}`).join(", ");

  for (const s of saved) {
    if (here.has(s.model)) continue;
    const free = SHOWS.filter((show) => !issued[show]).reduce((n, show) => n + s[show], 0);
    if (free > 0) cuts.push(`${s.model}: none on the shelf now, so it is off eBay (was ${describe(s)}).`);
  }
  // Models in a file already out that have none on the shelf now.
  const gone = new Set(FILE_KEYS.flatMap((f) => Object.keys(issued[f] ?? {})).filter((m) => !here.has(m) && outTotal(m) > 0));
  for (const m of gone) overListed.push(`${m}: none on the shelf, but the files already out list it (${where(m)}). Take it down on the platform.`);

  const lines = candidates.map((c): PlanLine => {
    const s = byModel.get(c.model);
    const setPrice = s ? s.setPrice && c.tpCents !== null && c.tpCents > 0 : defaultSetPrice(c.tpCents);
    const fixed = outTotal(c.model);
    let room = c.available - fixed;
    if (room < 0) {
      overListed.push(`${c.model}: ${c.available} on the shelf, but the files already out list ${fixed} (${where(c.model)}). Take ${-room} down on the platform.`);
      room = 0;
    }
    let AM = issued.AM ? out("AM", c.model) : (s?.AM ?? 0);
    let PM = issued.PM ? out("PM", c.model) : (s?.PM ?? 0);
    const freeShows = SHOWS.filter((show) => !issued[show]);
    if (freeShows.some((show) => (show === "AM" ? AM : PM) > 0) && missingForEbay(c).length > 0) {
      cuts.push(`${c.model}: off eBay — it no longer has its ${missingForEbay(c).join(", ")}.`);
      if (!issued.AM) AM = 0;
      if (!issued.PM) PM = 0;
    }
    const freeEbay = (issued.AM ? 0 : AM) + (issued.PM ? 0 : PM);
    if (freeEbay > room) {
      const was = describe({ AM, PM });
      let over = freeEbay - room;
      if (!issued.PM) {
        const fromPm = Math.min(PM, over);
        PM -= fromPm;
        over -= fromPm;
      }
      if (!issued.AM) AM -= Math.min(AM, over);
      cuts.push(`${c.model}: only ${c.available} on the shelf now, so eBay is ${describe({ AM, PM })} (was ${was}).`);
    }
    const left = room - ((issued.AM ? 0 : AM) + (issued.PM ? 0 : PM));
    const tiktok = issued.tiktok ? out("tiktok", c.model) : missingForTiktok(c).length === 0 ? left : 0;
    return { model: c.model, AM, PM, setPrice, tiktok };
  });
  return { lines, cuts, overListed };
}

const describe = (x: { AM: number; PM: number }) => `${x.AM} AM, ${x.PM} PM`;

/* --------------------------------------------------------------- the files */

/** The show tag eBay files carry in their Custom label: "09.08.26 PM". */
export function showTag(date: DateISO, show: Show): string {
  const [y, m, d] = date.split("-");
  return `${m}.${d}.${y.slice(2)} ${show}`;
}

const dollars = (cents: number) => Math.round(cents) / 100;

/** What a watch starts at: $1, or its target price when it runs at a set price. */
export function startPriceCents(line: Pick<PlanLine, "setPrice">, p: Pick<PlanProduct, "tpCents">): number {
  return line.setPrice && p.tpCents ? p.tpCents : 100;
}

/** An MSRP under this is a typing slip, not a price: the $800 is used instead. */
const MSRP_AT_LEAST_CENTS = 2_000;

/**
 * TikTok's fixed price: half the MSRP, or $800 until the model has a real
 * one — and never below what the auction starts at, so buying it outright is
 * never cheaper than the opening bid.
 */
export function tiktokPriceCents(p: Pick<PlanProduct, "msrpCents">, startCents = 100): number {
  const base = p.msrpCents && p.msrpCents >= MSRP_AT_LEAST_CENTS ? Math.round(p.msrpCents / 2) : TIKTOK_PRICE_FALLBACK_CENTS;
  return Math.max(base, startCents);
}

export type FileRow = Record<string, string | number | null>;

/**
 * The eBay listing rows for one show: one row per unit, as in the team's own
 * file ("Correct eBay Upload sheet"), keyed by its column headings. The fixed
 * values are copied from that file.
 */
export function ebayRows(lines: PlanLine[], products: Map<string, PlanProduct>, date: DateISO, show: Show): FileRow[] {
  const rows: FileRow[] = [];
  const tag = showTag(date, show);
  for (const line of [...lines].sort((a, b) => a.model.localeCompare(b.model))) {
    const p = products.get(line.model);
    if (!p || line[show] <= 0) continue;
    const row: FileRow = {
      "*Action(SiteID=US|Country=US|Currency=USD|Version=1193)": "Add",
      "Custom label (SKU)": tag,
      "Category ID": "31387",
      "Category name": "/Jewelry & Watches/Watches, Parts & Accessories/Watches/Wristwatches",
      Title: p.model,
      "Start price": dollars(startPriceCents(line, p)),
      Quantity: 1,
      "Item photo URL": p.imageUrl,
      "Condition ID": "1000-New with box and papers",
      Description: p.description,
      Format: "Auction",
      Duration: 7,
      Location: "Hollywood, FL",
      "Max dispatch time": 2,
      "Shipping profile name": p.ebayShippingProfile,
      "Return profile name": "eBay Live Return Policy - (ID: 257172185010)",
      "Payment profile name": "eBay Live Payment Policy - (ID: 257172135010)",
      "C:Brand": "Invicta",
      "C:Department": "Unisex Adults",
      "C:Type": "Wristwatch",
    };
    for (let i = 0; i < line[show]; i++) rows.push({ ...row });
  }
  return rows;
}

/** The safety-sheet picture every watch row carries in the team's TikTok file. */
const TIKTOK_SDS = "https://cdn.imageurlgenerator.com/uploads/b5d79b82-f690-41b1-9415-1cdb0c50607c.png";

/**
 * The day's TikTok rows: one per model with its quantity, as in the team's own
 * file ("Correct TT Upload Sheet"), keyed by the template's first-row field
 * names. The fixed values are copied from that file.
 */
export function tiktokRows(lines: PlanLine[], products: Map<string, PlanProduct>): FileRow[] {
  const rows: FileRow[] = [];
  for (const line of [...lines].sort((a, b) => a.model.localeCompare(b.model))) {
    const p = products.get(line.model);
    if (!p || line.tiktok <= 0) continue;
    rows.push({
      category: "Fashion Watches & Accessories/Fashion Men's Watches/Wrist Watches/Mechanical Watches",
      brand: "Invicta (7218045577127282437)",
      product_name: p.model,
      product_description: p.description,
      main_image: p.imageUrl,
      parcel_weight: p.weightLb,
      parcel_length: p.lengthIn,
      parcel_width: p.widthIn,
      parcel_height: p.heightIn,
      price: dollars(tiktokPriceCents(p, startPriceCents(line, p))),
      quantity: line.tiktok,
      special_product_listing_type: "Fixed price and LIVE auction",
      auction_starting_price: dollars(startPriceCents(line, p)),
      "product_property/100443": "Durable",
      "product_property/101619": "No",
      "product_property/101610": "Batteries",
      "product_property/100216": "Other",
      "product_property/101611": "Batteries built-in",
      "product_property/101614": 1,
      "product_property/101623": 1,
      "product_property/101624": 1,
      "product_property/101625": 1,
      "qualification/1729439947134305535": TIKTOK_SDS,
      "qualification/8647636475739801353": TIKTOK_SDS,
    });
  }
  return rows;
}

/**
 * The two upload templates, as the team's own files have them. `columns` is
 * the heading row the rows are keyed by (eBay: row 4; TikTok: row 1, the field
 * names its importer reads), in order; `headerRows` is how many rows the
 * template keeps above the listings (TikTok's sixth is its own example row,
 * frozen with the headings, and stays).
 */
export const LISTING_FILES = {
  ebay: {
    file: "ebay.xlsx",
    sheet: "xl/worksheets/sheet2.xml",
    sheetName: "Listings",
    headerRows: 4,
    headingRow: 4,
    columns: [
      "*Action(SiteID=US|Country=US|Currency=USD|Version=1193)", "Custom label (SKU)", "Category ID", "Category name", "Title",
      "Relationship", "Relationship details", "Schedule Time", "P:EPID", "Start price", "Quantity", "Item photo URL", "VideoID",
      "Condition ID", "Description", "Format", "Duration", "Buy It Now price", "Best Offer Enabled", "Best Offer Auto Accept Price",
      "Minimum Best Offer Price", "Immediate pay required", "Location", "Shipping service 1 option", "Shipping service 1 cost",
      "Shipping service 1 priority", "Shipping service 2 option", "Shipping service 2 cost", "Shipping service 2 priority",
      "Max dispatch time", "Returns accepted option", "Returns within option", "Refund option", "Return shipping cost paid by",
      "Shipping profile name", "Return profile name", "Payment profile name", "ProductCompliancePolicyID",
      "Regional ProductCompliancePolicies", "C:Brand", "C:Department", "C:Type", "C:Reference Number", "C:Customized", "C:Style",
      "C:Model", "C:Features", "C:Movement", "C:Dial Color", "C:Band Color", "C:Bezel Color", "C:Case Color", "C:Band Material",
      "C:Display", "C:Case Material", "C:Water Resistance", "C:Year Manufactured", "C:With Original Box/Packaging", "C:With Papers",
      "C:Indices", "Product Safety Pictograms", "Product Safety Statements", "Product Safety Component", "Regulatory Document Ids",
      "Manufacturer Name", "Manufacturer AddressLine1", "Manufacturer AddressLine2", "Manufacturer City", "Manufacturer Country",
      "Manufacturer PostalCode", "Manufacturer StateOrProvince", "Manufacturer Phone", "Manufacturer Email", "Manufacturer ContactURL",
      "Responsible Person 1", "Responsible Person 1 Type", "Responsible Person 1 AddressLine1", "Responsible Person 1 AddressLine2",
      "Responsible Person 1 City", "Responsible Person 1 Country", "Responsible Person 1 PostalCode",
      "Responsible Person 1 StateOrProvince", "Responsible Person 1 Phone", "Responsible Person 1 Email",
      "Responsible Person 1 ContactURL",
    ],
  },
  tiktok: {
    file: "tiktok.xlsx",
    sheet: "xl/worksheets/sheet1.xml",
    sheetName: "Template",
    headerRows: 6,
    headingRow: 1,
    columns: [
      "category", "brand", "product_name", "product_description", "main_image", "parcel_weight", "parcel_length", "parcel_width",
      "parcel_height", "price", "quantity", "special_product_listing_type", "auction_starting_price", "product_property/100198",
      "product_property/100347", "product_property/100392", "product_property/100443", "product_property/100701",
      "product_property/101571", "product_property/101574", "product_property/101619", "product_property/101395",
      "product_property/101398", "product_property/101400", "product_property/101397", "product_property/101610",
      "product_property/100216", "product_property/101611", "product_property/101614", "product_property/101623",
      "product_property/101624", "product_property/101625", "qualification/1729439947062478079",
      "qualification/1729439947134305535", "qualification/1729439947134502143", "qualification/8647636475739801353",
      "aimed_product_status",
    ],
  },
} as const;

export type ListingKind = keyof typeof LISTING_FILES;

/** A row keyed by heading, laid out in the template's column order. */
export function toCells(row: FileRow, columns: readonly string[]): (string | number | null)[] {
  return columns.map((c) => row[c] ?? null);
}

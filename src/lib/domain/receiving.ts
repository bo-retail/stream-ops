/**
 * Inventory, step 2: receiving.
 *
 * Pure, like everything under `src/lib/domain`: reading Daniel's offer and
 * Invicta's shipping list, what a shipment count does to stock and cost, what
 * is still to come, and which differences there are with Invicta. The
 * database and the pages are elsewhere.
 *
 * The flow, in Daniel's words: the offer creates the item, the shipping list
 * says how many to expect, Gladys's count makes it active. Only the count
 * moves stock — Invicta's list is what they say they sent, not what is here.
 */
import type { Cell, SheetRows } from "./inventory-sheets";
import { badModelNumber, normaliseModel, parseMoney, parseQty } from "./inventory";
import { storableLink } from "./watch-images";
import type { DateISO } from "./types";

/* ------------------------------------------------------------------ helpers */

const lower = (s: string) => s.trim().toLowerCase();

/** A cell by any of its names, matched loosely (case, spaces). Null when blank. */
function pick(values: Record<string, Cell>, ...names: string[]): Cell {
  for (const name of names) {
    const key = Object.keys(values).find((k) => lower(k) === lower(name));
    if (key !== undefined) {
      const v = values[key];
      if (v !== null && String(v).trim() !== "") return v;
    }
  }
  return null;
}

const text = (v: Cell) => (v === null ? "" : String(v).trim());

/** Excel's way of saying "no value": #N/A, #REF! and the like. */
const isExcelError = (v: Cell) => typeof v === "string" && /^#[A-Z/0!?]+[!?]?$/i.test(v.trim());

/* -------------------------------------------------------------------- offer */

/** The offer's heading row is the one with `Dani` in it (Daniel's column). */
export const isOfferHeading = (cell: string) => lower(cell) === "dani";

const OFFER_COLUMNS = ["invicta model", "model", "brand", "collection", "gender", "small main image", "url", "image url", "dani", "bo costs", "product type"];
export const isOfferColumn = (heading: string) => OFFER_COLUMNS.includes(lower(heading));

export interface OfferLineIn {
  model: string;
  qty: number;
  costCents: number;
  /** Copied onto a model the offer creates; never over anything already there. */
  brand: string;
  collection: string;
  gender: string;
  imageUrl: string;
}

/**
 * The lines of an offer that Daniel ordered: a `Dani` quantity above zero.
 *
 * A blank or 0 in `Dani` is a model he did not order, skipped without a word.
 * Anything else that cannot be read — a quantity that is not a whole number,
 * an order with no cost, a model number Excel damaged — is a problem, and the
 * offer is not saved until it is fixed, so a half-read order never stands in
 * for the real one.
 */
export function readOffer(sheets: SheetRows): { lines: OfferLineIn[]; problems: string[] } {
  const lines = new Map<string, OfferLineIn>();
  const problems: string[] = [];
  for (const sheet of sheets) {
    for (const { line, values } of sheet.rows) {
      const where = `${sheet.sheet} row ${line}`;
      const daniRaw = pick(values, "Dani");
      const dani = isExcelError(daniRaw) ? { kind: "bad" as const, why: `${daniRaw} in Dani` } : parseQty(daniRaw);
      if (dani.kind === "blank" || (dani.kind === "ok" && dani.qty === 0)) continue;
      const model = normaliseModel(pick(values, "Invicta Model", "Model"));
      if (dani.kind === "bad") {
        problems.push(`${where}${model ? ` (${model})` : ""}: ${dani.why}.`);
        continue;
      }
      const bad = badModelNumber(model);
      if (bad) {
        problems.push(`${where}: ${bad}.`);
        continue;
      }
      const costRaw = pick(values, "BO COSTS");
      const costCents = isExcelError(costRaw) ? null : parseMoney(costRaw);
      if (costCents === null || costCents === 0) {
        problems.push(`${where} (${model}): ordered ${dani.qty} but BO COSTS has no cost.`);
        continue;
      }
      const before = lines.get(model);
      if (before) {
        if (before.costCents !== costCents) {
          problems.push(`${where}: ${model} is on the offer twice at different costs.`);
          continue;
        }
        before.qty += dani.qty;
        continue;
      }
      lines.set(model, {
        model,
        qty: dani.qty,
        costCents,
        brand: text(pick(values, "Brand")),
        collection: text(pick(values, "Collection")),
        gender: text(pick(values, "Gender")),
        imageUrl: storableLink(text(pick(values, "Small Main Image", "URL", "Image URL"))),
      });
    }
  }
  return { lines: [...lines.values()], problems };
}

/**
 * The date an offer is named by, read from its file name: "09.19 BO retail
 * offer_.xlsx" is 19 September. The year is this year, unless that would put
 * it more than a month ahead, in which case it is last year's. Null when the
 * name carries no date; the page then asks for one.
 */
export function offerDateFromName(fileName: string, today: DateISO): DateISO | null {
  const m = /(?:^|[^\d])(\d{1,2})[.\-_/](\d{1,2})(?:[.\-_/](\d{2,4}))?(?!\d)/.exec(fileName);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(today.slice(0, 4));
  let iso = `${year}-${pad(month)}-${pad(day)}`;
  // 31 February and the like.
  if (new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) return null;
  if (!m[3] && iso > addMonth(today)) {
    year -= 1;
    iso = `${year}-${pad(month)}-${pad(day)}`;
  }
  return iso as DateISO;
}

function addMonth(d: DateISO): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 31);
  return t.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------ shipping list */

/** The shipping list's heading row has "SOP Number" (or just "SOP"). */
export const isShippingListHeading = (cell: string) => /^sop( number)?$/i.test(cell.trim());

export interface ShipmentIn {
  sop: string;
  po: string;
  lines: { model: string; qty: number; unitCostCents: number }[];
}

/**
 * Invicta's shipping list, one shipment per SOP.
 *
 * One list can carry several SOPs. A model twice in the same SOP at the same
 * price is one line of both quantities; at two prices it is a problem, because
 * Daniel says that never happens and a wrong cost would follow it into stock.
 */
export function readShippingList(sheets: SheetRows): { shipments: ShipmentIn[]; problems: string[] } {
  type Line = ShipmentIn["lines"][number];
  const bySop = new Map<string, { sop: string; po: string; lines: Line[]; at: Map<string, Line> }>();
  const problems: string[] = [];
  for (const sheet of sheets) {
    for (const { line, values } of sheet.rows) {
      const where = `${sheet.sheet} row ${line}`;
      const sop = text(pick(values, "SOP Number", "SOP")).toUpperCase();
      const model = normaliseModel(pick(values, "Item", "Model", "Invicta Model"));
      const qtyRaw = pick(values, "Quantity", "Qty");
      const priceRaw = pick(values, "Unit Price", "Price");
      // A totals row: no SOP and no model.
      if (sop === "" && model === "") continue;
      if (sop === "") {
        problems.push(`${where} (${model}): no SOP number.`);
        continue;
      }
      const bad = badModelNumber(model);
      if (bad) {
        problems.push(`${where}: ${bad}.`);
        continue;
      }
      const qty = parseQty(qtyRaw);
      if (qty.kind !== "ok" || qty.qty === 0) {
        problems.push(`${where} (${model}): ${qty.kind === "bad" ? qty.why : "no quantity"}.`);
        continue;
      }
      const price = isExcelError(priceRaw) ? null : parseMoney(priceRaw);
      if (price === null) {
        problems.push(`${where} (${model}): no unit price.`);
        continue;
      }
      const s = bySop.get(sop) ?? { sop, po: text(pick(values, "Customer PO Number", "PO")), lines: [] as Line[], at: new Map<string, Line>() };
      bySop.set(sop, s);
      const before = s.at.get(model);
      if (before) {
        if (before.unitCostCents !== price) {
          problems.push(`${where}: ${model} is on ${sop} twice at different prices ($${(before.unitCostCents / 100).toFixed(2)} and $${(price / 100).toFixed(2)}).`);
          continue;
        }
        before.qty += qty.qty;
        continue;
      }
      const l = { model, qty: qty.qty, unitCostCents: price };
      s.at.set(model, l);
      s.lines.push(l);
    }
  }
  return { shipments: [...bySop.values()].map(({ sop, po, lines }) => ({ sop, po, lines })), problems };
}

/* ----------------------------------------------------------- the count in */

export interface LineCount {
  counted: number;
  damaged: number;
}

/**
 * What saving a shipment line's count does to stock: the change in good pieces
 * (to Sellable) and in damaged ones (to Damaged), against what was saved for
 * it before. A first count is against nothing; a corrected count moves only
 * the difference, so saving the same numbers twice moves nothing.
 */
export function receiptChange(before: LineCount | null, after: LineCount): { sellable: number; damaged: number; pieces: number } {
  const b = before ?? { counted: 0, damaged: 0 };
  return {
    sellable: after.counted - after.damaged - (b.counted - b.damaged),
    damaged: after.damaged - b.damaged,
    pieces: after.counted - b.counted,
  };
}

/**
 * A count's numbers, checked: whole numbers, damaged no more than counted.
 * Damaged blank means none.
 */
export function readLineCount(countedRaw: unknown, damagedRaw: unknown): { ok: true; count: LineCount } | { ok: false; why: string } | { ok: "blank" } {
  const counted = parseQty(countedRaw);
  const damaged = parseQty(damagedRaw);
  if (counted.kind === "bad") return { ok: false, why: `Counted: ${counted.why}` };
  if (damaged.kind === "bad") return { ok: false, why: `Damaged: ${damaged.why}` };
  if (counted.kind === "blank") {
    return damaged.kind === "ok" && damaged.qty > 0 ? { ok: false, why: "Damaged is filled in but Counted is blank. Counted includes the damaged ones." } : { ok: "blank" };
  }
  const d = damaged.kind === "ok" ? damaged.qty : 0;
  if (d > counted.qty) return { ok: false, why: `${d} damaged but only ${counted.qty} counted. Counted includes the damaged ones.` };
  return { ok: true, count: { counted: counted.qty, damaged: d } };
}

/**
 * A model's cost after pieces arrive at a price: the weighted average of what
 * was on hand and what came in. A model with nothing on hand, or no cost yet,
 * simply takes the new price. A correction that takes pieces back out moves
 * the average the other way, at the same price, so a count corrected back
 * leaves the cost where it was — to within a cent, as costs are kept in whole
 * cents.
 */
export function weightedCost(currentCents: number | null, onHand: number, priceCents: number | null, pieces: number): number | null {
  if (priceCents === null || pieces === 0) return currentCents;
  if (currentCents === null || onHand <= 0) return pieces > 0 ? priceCents : currentCents;
  const after = onHand + pieces;
  if (after <= 0) return currentCents;
  return Math.max(0, Math.round((currentCents * onHand + priceCents * pieces) / after));
}

/* -------------------------------------------------------- differences */

export type DifferenceKind = "short" | "over" | "not on the list" | "damaged";

/**
 * What is different between Invicta's list and Gladys's count, for one line.
 * Gladys's count is the truth: short means they ship the balance, over means
 * they adjust the invoice, damaged means a credit or a replacement. Empty
 * until the line is counted, and for a line that matched.
 */
export function differences(line: { listedQty: number; countedQty: number | null; damagedQty: number | null }): { kind: DifferenceKind; qty: number }[] {
  if (line.countedQty === null) return [];
  const out: { kind: DifferenceKind; qty: number }[] = [];
  const diff = line.countedQty - line.listedQty;
  if (line.listedQty === 0 && line.countedQty > 0) out.push({ kind: "not on the list", qty: line.countedQty });
  else if (diff < 0) out.push({ kind: "short", qty: -diff });
  else if (diff > 0) out.push({ kind: "over", qty: diff });
  if ((line.damagedQty ?? 0) > 0) out.push({ kind: "damaged", qty: line.damagedQty! });
  return out;
}

/* ------------------------------------------------------- still to come */

/** How long an ordered model waits on "still to come" before it drops off (it stays in the history). */
export const STILL_TO_COME_DAYS = 60;

/**
 * What was ordered and has not been shipped yet.
 *
 * Per model, the offers are filled oldest first by what Invicta's shipping
 * lists say they sent on or after each offer's date. An offer older than
 * {@link STILL_TO_COME_DAYS} drops off, whatever is left on it.
 */
export function stillToCome(
  offers: { date: DateISO; lines: { model: string; qty: number }[] }[],
  shipped: { date: DateISO; model: string; qty: number }[],
  today: DateISO,
): { model: string; offerDate: DateISO; ordered: number; shipped: number; toCome: number }[] {
  const cutoff = minusDays(today, STILL_TO_COME_DAYS);
  const sorted = [...offers].sort((a, b) => a.date.localeCompare(b.date));
  const out: { model: string; offerDate: DateISO; ordered: number; shipped: number; toCome: number }[] = [];
  const models = new Set(sorted.flatMap((o) => o.lines.map((l) => l.model)));
  for (const model of models) {
    // Each shipment of the model, used once, against the oldest offer it can fill.
    const pool = shipped.filter((s) => s.model === model).map((s) => ({ ...s })).sort((a, b) => a.date.localeCompare(b.date));
    for (const offer of sorted) {
      const ordered = offer.lines.filter((l) => l.model === model).reduce((n, l) => n + l.qty, 0);
      if (ordered === 0) continue;
      let filled = 0;
      for (const s of pool) {
        if (s.date < offer.date || s.qty === 0 || filled === ordered) continue;
        const take = Math.min(s.qty, ordered - filled);
        s.qty -= take;
        filled += take;
      }
      if (offer.date < cutoff) continue;
      if (filled < ordered) out.push({ model, offerDate: offer.date, ordered, shipped: filled, toCome: ordered - filled });
    }
  }
  return out.sort((a, b) => a.offerDate.localeCompare(b.offerDate) || a.model.localeCompare(b.model));
}

function minusDays(d: DateISO, days: number): DateISO {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - days);
  return t.toISOString().slice(0, 10) as DateISO;
}

/* --------------------------------------------------- product details */

/** The product details sheet's columns, in order. Blank keeps what the model has. */
export const DETAILS_COLUMNS = [
  "Model", "Brand", "Collection", "Gender", "Description", "Cost", "TP", "MSRP",
  "Weight (lb)", "Length (in)", "Width (in)", "Height (in)", "eBay shipping profile", "UPC", "Image URL",
] as const;

export const isDetailsHeading = (cell: string) => lower(cell) === "model";

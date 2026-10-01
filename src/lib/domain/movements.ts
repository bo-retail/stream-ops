/**
 * Inventory, step 4: moving stock by hand.
 *
 * Pure, like everything under `src/lib/domain`: reading a row of the moves,
 * adjustments or returns template (or the same row typed on the site — both
 * come through here, so they are checked the same way), and what each does.
 * The database is elsewhere (`server/movements.ts`).
 *
 *   - **Moves** shift pieces between the five places without changing the
 *     total: a sample pulled, a damaged sample replaced, samples to random
 *     pulls when the shelf runs out.
 *   - **Adjustments** add or take away, with a reason from Daniel's list.
 *   - **Returns and cancellations**, once Gladys has the watch in her hand:
 *     back in stock (from "waiting" if it never shipped, at the cost it left
 *     with if it did), an exchange or reship (a watch goes out with no new
 *     sale), or a refund with no watch.
 */
import { PLACES, PLACE_LABEL, normaliseModel, parseQty } from "./inventory";
import type { Place } from "./inventory";

/* ---------------------------------------------------------------- the lists */

export const MOVE_REASONS = [
  "Sample pulled", "Sample back to shelf", "Sample damaged", "Replacement sample", "Sample to random pulls", "Random pull back to shelf",
] as const;

/** Daniel's list. Damaged moves the pieces to Damaged; the rest add or take away. */
export const ADJUST_REASONS = ["Damaged", "Owner gift", "Content", "Giveaway", "Lost", "Direct sale", "Miscount", "Found", "Written off / credited"] as const;
const SUBTRACT_ONLY = new Set<string>(["Damaged", "Owner gift", "Content", "Giveaway", "Lost", "Direct sale", "Written off / credited"]);
const ADD_ONLY = new Set<string>(["Found"]);

export const RETURN_TYPES = ["Back in stock", "Exchange / reship", "Refund only"] as const;
export type ReturnType = (typeof RETURN_TYPES)[number];
/** Older words for "Back in stock", still accepted so nobody is turned away over wording. */
const RETURN_ALIASES: Record<string, ReturnType> = {
  return: "Back in stock", returned: "Back in stock", cancelled: "Back in stock", canceled: "Back in stock",
  "cancelled before shipping": "Back in stock", "not shipped": "Back in stock", exchange: "Exchange / reship", reship: "Exchange / reship",
  refund: "Refund only",
};
/** Words that say "cancelled": those need the order, so the right waiting watch comes back. */
const CANCEL_WORDS = new Set(["cancelled", "canceled", "cancelled before shipping", "not shipped"]);
/** Where a watch back in stock goes: the shelf, random pulls (slightly damaged — always, Daniel round 5), or damaged. */
export const RETURN_PLACES = ["Sellable", "Random pulls", "Damaged"] as const;
const RETURN_TO: Record<string, Place> = { inventory: "SELLABLE", sellable: "SELLABLE", "random pulls": "RANDOM_PULLS", damaged: "DAMAGED" };

/**
 * An order number as typed or pasted: "#", spaces and a stray ".0" gone. A
 * number Excel has already rounded (a TikTok order id is 18 digits; Excel keeps
 * 15) is refused rather than matched to the wrong order.
 */
export function readOrder(raw: string | number | null | undefined): { ok: true; order: string } | { ok: false; why: string } {
  if (raw === null || raw === undefined) return { ok: true, order: "" };
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) return { ok: false, why: `the order number ${raw} was changed by Excel — type it in a text cell, or copy it again` };
    return { ok: true, order: String(raw) };
  }
  const t = raw.trim().replace(/^#\s*/, "").replace(/\s+/g, "").replace(/\.0+$/, "");
  if (/e\+?\d+$/i.test(t)) return { ok: false, why: `the order number "${raw.trim()}" was changed by Excel — type it in a text cell` };
  return { ok: true, order: t };
}

/** The template columns, in order. */
export const MOVE_COLUMNS = ["Model #", "Quantity", "From", "To", "Reason", "Note"] as const;
export const ADJUST_COLUMNS = ["Model #", "Action", "Quantity", "Place", "Reason", "Note"] as const;
export const RETURN_COLUMNS = ["Model #", "Quantity", "Type", "Goes to", "Order #", "Condition / note"] as const;

/* ------------------------------------------------------------------ reading */

/** A row as typed or as a sheet gives it: cells by column name. */
export type Row = Partial<Record<string, string | number | null>>;

const cell = (row: Row, ...names: string[]) => {
  for (const n of names) {
    const k = Object.keys(row).find((h) => h.trim().toLowerCase() === n.toLowerCase());
    if (k !== undefined && row[k] !== null && row[k] !== undefined && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return "";
};

/** One of the five places, by the name on the screen or a short form of it. */
export function readPlace(raw: string): Place | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (t === "") return null;
  const aliases: Record<string, Place> = {
    sellable: "SELLABLE", shelf: "SELLABLE", inventory: "SELLABLE",
    "sample ebay": "SAMPLE_EBAY", "ebay sample": "SAMPLE_EBAY", ebay: "SAMPLE_EBAY",
    "sample tiktok": "SAMPLE_TIKTOK", "tiktok sample": "SAMPLE_TIKTOK", tiktok: "SAMPLE_TIKTOK",
    "random pulls": "RANDOM_PULLS", "random pull": "RANDOM_PULLS", damaged: "DAMAGED",
  };
  if (aliases[t]) return aliases[t];
  // The database names too ("SAMPLE_EBAY", "random_pulls").
  return PLACES.find((p) => p.toLowerCase() === t.replace(/ /g, "_")) ?? null;
}

const pick = <T extends string>(list: readonly T[], raw: string): T | null => list.find((x) => x.toLowerCase() === raw.trim().toLowerCase()) ?? null;
const placeNames = PLACES.map((p) => PLACE_LABEL[p]).join(", ");

function readQty(raw: string): { qty: number } | { why: string } {
  if (raw === "") return { why: "the quantity is missing" };
  const q = parseQty(raw);
  if (q.kind !== "ok") return { why: q.kind === "bad" ? q.why : "the quantity is missing" };
  if (q.qty === 0) return { why: "the quantity is 0" };
  return { qty: q.qty };
}

/** Is the row empty (a blank line at the bottom of a sheet)? */
export const isBlankRow = (row: Row) => Object.values(row).every((v) => v === null || v === undefined || String(v).trim() === "");

export interface Move {
  model: string;
  qty: number;
  from: Place;
  to: Place;
  reason: string;
  note: string;
}

export function readMove(row: Row): { ok: true; move: Move } | { ok: false; why: string } {
  const model = normaliseModel(cell(row, "Model #", "Model"));
  if (model === "") return { ok: false, why: "no model number" };
  const q = readQty(cell(row, "Quantity", "Qty"));
  if ("why" in q) return { ok: false, why: `${model}: ${q.why}` };
  const from = readPlace(cell(row, "From"));
  const to = readPlace(cell(row, "To"));
  if (!from || !to) return { ok: false, why: `${model}: From and To must each be one of ${placeNames}` };
  if (from === to) return { ok: false, why: `${model}: From and To are the same place` };
  const reason = pick(MOVE_REASONS, cell(row, "Reason"));
  if (!reason) return { ok: false, why: `${model}: the reason must be one of ${MOVE_REASONS.join(", ")}` };
  return { ok: true, move: { model, qty: q.qty, from, to, reason, note: cell(row, "Note", "Notes").slice(0, 500) } };
}

export interface Adjustment {
  model: string;
  /** Positive adds, negative takes away. */
  qty: number;
  place: Place;
  reason: string;
  note: string;
}

export function readAdjustment(row: Row): { ok: true; adjustment: Adjustment } | { ok: false; why: string } {
  const model = normaliseModel(cell(row, "Model #", "Model"));
  if (model === "") return { ok: false, why: "no model number" };
  const action = cell(row, "Action").toLowerCase();
  if (action !== "add" && action !== "subtract") return { ok: false, why: `${model}: Action must be Add or Subtract` };
  const q = readQty(cell(row, "Quantity", "Qty"));
  if ("why" in q) return { ok: false, why: `${model}: ${q.why}` };
  const place = readPlace(cell(row, "Place") || "Sellable");
  if (!place) return { ok: false, why: `${model}: Place must be one of ${placeNames}` };
  const reason = pick(ADJUST_REASONS, cell(row, "Reason"));
  if (!reason) return { ok: false, why: `${model}: the reason must be one of ${ADJUST_REASONS.join(", ")}` };
  if (action === "add" && SUBTRACT_ONLY.has(reason)) return { ok: false, why: `${model}: ${reason} can only subtract` };
  if (action === "subtract" && ADD_ONLY.has(reason)) return { ok: false, why: `${model}: ${reason} can only add` };
  if (reason === "Damaged" && place === "DAMAGED") return { ok: false, why: `${model}: it is already in Damaged` };
  return { ok: true, adjustment: { model, qty: action === "add" ? q.qty : -q.qty, place, reason, note: cell(row, "Note", "Notes").slice(0, 500) } };
}

export interface ReturnRow {
  model: string;
  qty: number;
  type: ReturnType;
  /** Where a watch back in stock goes; null for the other two types. */
  to: Place | null;
  order: string;
  note: string;
}

export function readReturn(row: Row): { ok: true; ret: ReturnRow } | { ok: false; why: string } {
  const model = normaliseModel(cell(row, "Model #", "Model"));
  if (model === "") return { ok: false, why: "no model number" };
  const q = readQty(cell(row, "Quantity", "Qty"));
  if ("why" in q) return { ok: false, why: `${model}: ${q.why}` };
  const typed = cell(row, "Type") || "Back in stock";
  const type = pick(RETURN_TYPES, typed) ?? RETURN_ALIASES[typed.trim().toLowerCase()] ?? null;
  if (!type) return { ok: false, why: `${model}: Type must be one of ${RETURN_TYPES.join(", ")}` };
  const goesTo = cell(row, "Goes to");
  const to = type === "Back in stock" ? (RETURN_TO[goesTo.trim().toLowerCase()] ?? null) : null;
  if (type === "Back in stock" && !to) return { ok: false, why: `${model}: Goes to must be one of ${RETURN_PLACES.join(", ")} — where Gladys put it` };
  const orderKey = Object.keys(row).find((h) => ["order #", "order"].includes(h.trim().toLowerCase()));
  const order = readOrder(orderKey === undefined ? null : (row[orderKey] ?? null));
  if (!order.ok) return { ok: false, why: `${model}: ${order.why}` };
  if (CANCEL_WORDS.has(typed.trim().toLowerCase()) && order.order === "") {
    return { ok: false, why: `${model}: a cancellation needs its order number, so the right waiting watch comes back` };
  }
  return { ok: true, ret: { model, qty: q.qty, type, to, order: order.order, note: cell(row, "Condition / note", "Note").slice(0, 500) } };
}

/* -------------------------------------------------------- what Gladys is asked */

export interface ModelState {
  model: string;
  balances: Record<Place, number>;
  /** When it first came in on a shipment, if it did. */
  firstReceived: Date | null;
  /** When a sale last came off its shelf, if one has: the shelf "ran out" only if it was selling. */
  lastShelfSale?: Date | null;
}

export interface Prompt {
  model: string;
  kind: "pull samples" | "samples to random pulls";
  /** What the button would move. */
  moves: Omit<Move, "note">[];
  text: string;
}

/** How recent a first arrival counts as "new" for the sample prompt. */
export const NEW_MODEL_DAYS = 14;

/**
 * What to ask Gladys, never to do on her behalf:
 *
 *   - a model that arrived for the first time recently and has no sample on
 *     a table: pull one for eBay and one for TikTok (as many as the shelf
 *     allows — a model of very few pieces may only give one);
 *   - a model whose shelf has run out while it still has samples: move them to
 *     random pulls, so those physical watches can ship.
 */
export function prompts(models: ModelState[], now: Date): Prompt[] {
  const out: Prompt[] = [];
  for (const m of models) {
    const b = m.balances;
    const isNew = m.firstReceived !== null && now.getTime() - m.firstReceived.getTime() <= NEW_MODEL_DAYS * 86_400_000;
    if (isNew && b.SELLABLE > 0 && (b.SAMPLE_EBAY <= 0 || b.SAMPLE_TIKTOK <= 0)) {
      const moves: Omit<Move, "note">[] = [];
      let shelf = b.SELLABLE;
      for (const to of ["SAMPLE_EBAY", "SAMPLE_TIKTOK"] as const) {
        if (b[to] <= 0 && shelf > 0) {
          moves.push({ model: m.model, qty: 1, from: "SELLABLE", to, reason: "Sample pulled" });
          shelf--;
        }
      }
      out.push({
        model: m.model,
        kind: "pull samples",
        moves,
        text: `New in, ${b.SELLABLE} on the shelf, no sample on ${moves.map((x) => (x.to === "SAMPLE_EBAY" ? "the eBay table" : "the TikTok table")).join(" or ")}.`,
      });
      continue;
    }
    const samples = Math.max(0, b.SAMPLE_EBAY) + Math.max(0, b.SAMPLE_TIKTOK);
    // Only a shelf that ran out by selling lately — not every model whose last
    // pieces happened to be the samples on the day of the opening count.
    const ranOut = m.lastShelfSale != null && now.getTime() - m.lastShelfSale.getTime() <= NEW_MODEL_DAYS * 86_400_000;
    if (b.SELLABLE <= 0 && samples > 0 && ranOut) {
      out.push({
        model: m.model,
        kind: "samples to random pulls",
        moves: (["SAMPLE_EBAY", "SAMPLE_TIKTOK"] as const)
          .filter((p) => b[p] > 0)
          .map((p) => ({ model: m.model, qty: b[p], from: p, to: "RANDOM_PULLS" as const, reason: "Sample to random pulls" })),
        text: `Nothing left on the shelf; ${samples} sample${samples === 1 ? "" : "s"} on the show tables.`,
      });
    }
  }
  return out;
}

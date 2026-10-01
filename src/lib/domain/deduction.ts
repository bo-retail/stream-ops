/**
 * Inventory, step 3: paid orders come off stock.
 *
 * Pure, like everything under `src/lib/domain`: given the day's reports as they
 * stand, the boxes as packing left them and what stock already knows, what has
 * to change. The database is elsewhere (`server/deduction.ts`).
 *
 * Daniel's rule, in two halves:
 *
 *   - **Sold.** A paid report line takes the watch off where it sits and puts
 *     it in "sold, waiting to ship": no longer available, still in the
 *     building. A normal listing comes off the shelf (then its platform's
 *     sample, then the other's — an expensive model can sell from its sample).
 *     A random pull comes off random pulls of the watch the report's
 *     `Model #` names, or the piece the packer scanned for it.
 *   - **Sent.** When its box is closed at packing, it leaves — as far as what
 *     was scanned into the box says it did.
 *
 * It works by comparing what should be with what is, one watch at a time, so
 * running it twice changes nothing, a corrected report puts back what it no
 * longer has, and a reopened box brings its watches back to "waiting".
 */
import { isPlaceholderStock } from "./imports/placeholders";
import { normaliseStockNumber } from "./imports/tracking";
import { normaliseModel } from "./inventory";
import type { Place } from "./inventory";
import type { DateISO } from "./types";

export type SalePlatform = "TIKTOK" | "EBAY";
export type BoxStatus = "OPEN" | "CLOSED_COMPLETE" | "CLOSED_INCOMPLETE" | "CLOSED_UNVERIFIED";

/** A paid line from the reports as they currently stand. */
export interface SaleLine {
  platform: SalePlatform;
  orderRef: string;
  lineRef: string;
  showDate: DateISO;
  show: string;
  tracking: string;
  /** What it sold as: a stock number, or a random-pull listing. */
  stockNumber: string;
  /** The report's `Model #`, blank when there is none. */
  modelNumber: string;
  qty: number;
  /** The upload it came from, and when: an order in two uploads is read from the latest. */
  batchId: string;
  uploadedAt: number;
}

/** A box as packing left it, by tracking number. */
export interface BoxState {
  status: BoxStatus;
  /** Scanned so far, per stock number (normalised). */
  scanned: Record<string, number>;
  /** The real pieces scanned for each placeholder listing (normalised), in scan order. */
  pieces: Record<string, string[]>;
}

/** What stock already knows about one sold watch. */
export interface KnownSale {
  key: string;
  model: string;
  place: Place;
  /** CANCELLED and RETURNED were settled by hand (step 4): never touched again here. */
  status: "SOLD" | "SENT" | "UNDONE" | "CANCELLED" | "RETURNED";
  flag: string;
  tracking: string;
}

export interface CatalogueEntry {
  costCents: number | null;
}

/** One sold watch, as the reports and the boxes say it should be. */
export interface Wanted {
  key: string;
  line: SaleLine;
  /** The model it is, or null when nothing names it yet (a random pull with no `Model #` and no scan). */
  model: string | null;
  sent: boolean;
  /** Why it is worth a look even if all goes well ("packed as X, Model # said Y"). */
  note: string;
}

/** A watch scanned into a closed box that no sale in that box accounts for. */
export interface Stray {
  tracking: string;
  model: string;
  qty: number;
}

export type Change =
  | { kind: "sell"; key: string; line: SaleLine; model: string; place: Place; costCents: number | null; sent: boolean; flag: string; reuse: boolean }
  | { kind: "unsell"; key: string; model: string; place: Place }
  | { kind: "send"; key: string; model: string }
  | { kind: "unsend"; key: string; model: string }
  | { kind: "flag"; key: string; flag: string };

export interface Plan {
  changes: Change[];
  /** Random pulls nothing names yet: revenue counts, the watch waits for a scan or a `Model #`. */
  unnamed: Wanted[];
  /** Lines naming a model the catalogue does not have: not taken off. */
  unknown: Wanted[];
}

/**
 * One key per watch: the order, what it sold as, and which of that order's
 * watches of that stock number it is. Deliberately not the line id — eBay's
 * `Transaction ID` is a long number Excel rounds to "1.00851E+13" when the file
 * is opened and saved, and two watches of one order then share it.
 */
export const saleKey = (platform: SalePlatform, orderRef: string, stockNumber: string, nth: number) =>
  `${platform}|${orderRef}|${normaliseStockNumber(stockNumber)}|${nth}`;

const CLOSED: BoxStatus[] = ["CLOSED_COMPLETE", "CLOSED_INCOMPLETE", "CLOSED_UNVERIFIED"];

/** A listing that is a random pull by its own words, whatever numbers it carries ("#300 - Invicta Random Pulls"). */
const SAYS_RANDOM = /random|pull/i;

/**
 * Every watch the reports say was sold, one per unit, with its model and
 * whether its box has gone — and any watch scanned into a closed box that no
 * sale accounts for.
 *
 * An order in two uploads (overlapping downloads, a late eBay payer carried to
 * its show) is read from the latest upload only, so the answer never depends
 * on which copy came first. In a box, what was scanned is handed out to the
 * sales in it: a normal watch is sent as far as its stock number was scanned
 * (a box closed complete scanned all of them; one marked sent without scanning
 * sends all); a random pull is sent with the piece scanned for it, the piece
 * equal to its `Model #` first.
 */
export function wantedSales(
  lines: SaleLine[],
  boxes: ReadonlyMap<string, BoxState>,
  isModel: (model: string) => boolean = () => false,
): { wanted: Wanted[]; strays: Stray[] } {
  // The latest upload of each order's watches of one stock number. Per stock
  // number, not per order: an eBay order won across two days keeps each day's
  // line in that day's report, and both are current.
  const latest = new Map<string, { batchId: string; uploadedAt: number }>();
  const groupOf = (l: SaleLine) => `${l.platform}|${l.orderRef}|${normaliseStockNumber(l.stockNumber)}`;
  for (const l of lines) {
    const k = groupOf(l);
    const best = latest.get(k);
    if (!best || l.uploadedAt > best.uploadedAt || (l.uploadedAt === best.uploadedAt && l.batchId > best.batchId)) {
      latest.set(k, { batchId: l.batchId, uploadedAt: l.uploadedAt });
    }
  }
  const kept = lines
    .filter((l) => latest.get(groupOf(l))!.batchId === l.batchId)
    // Everything that tells two lines apart, before the line id (which Excel can
    // round to the same number), so the order of rows in a file never matters.
    .sort(
      (a, b) =>
        a.platform.localeCompare(b.platform) ||
        a.orderRef.localeCompare(b.orderRef) ||
        normaliseStockNumber(a.stockNumber).localeCompare(normaliseStockNumber(b.stockNumber)) ||
        a.tracking.localeCompare(b.tracking) ||
        normaliseModel(a.modelNumber).localeCompare(normaliseModel(b.modelNumber)) ||
        a.qty - b.qty ||
        a.lineRef.localeCompare(b.lineRef),
    );

  // Each order's watches of one stock number, numbered 0, 1, 2…
  const nthInOrder = new Map<string, number>();
  type Unit = { key: string; line: SaleLine; stock: string; reported: string; inName: string };
  const units: Unit[] = [];
  for (const line of kept) {
    const stock = normaliseStockNumber(line.stockNumber);
    const placeholder = isPlaceholderStock(line.stockNumber);
    // Model # can name each watch of a line of two or more: "40022;45802".
    const named = line.modelNumber.split(/[;,/]/).map(normaliseModel).filter(Boolean);
    // A listing with a space that still names a real model ("Invicta 48912") is that model —
    // unless it says it is a random pull, whatever numbers it has.
    const inName =
      placeholder && !SAYS_RANDOM.test(line.stockNumber)
        ? (line.stockNumber.split(/[^0-9A-Za-z-]+/).map(normaliseModel).find((w) => w && isModel(w)) ?? "")
        : "";
    for (let unit = 0; unit < Math.max(1, line.qty); unit++) {
      const ok = `${line.platform}|${line.orderRef}|${stock}`;
      const nth = nthInOrder.get(ok) ?? 0;
      nthInOrder.set(ok, nth + 1);
      units.push({ key: saleKey(line.platform, line.orderRef, stock, nth), line, stock, reported: named[unit] ?? named[0] ?? "", inName });
    }
  }

  // What each closed box has left to hand out.
  const budget = new Map<string, Record<string, number>>();
  const piecesLeft = new Map<string, Record<string, string[]>>();
  for (const [tracking, box] of boxes) {
    budget.set(tracking, { ...box.scanned });
    piecesLeft.set(tracking, Object.fromEntries(Object.entries(box.pieces).map(([k, v]) => [k, [...v]])));
  }
  const closedBox = (tracking: string) => {
    const box = tracking ? boxes.get(tracking) : undefined;
    return box && CLOSED.includes(box.status) ? box : undefined;
  };

  const result = new Map<string, Wanted>();
  // Random pulls first take the piece equal to their own Model #, so two in one
  // box are never flagged for having been scanned in the other order.
  for (const u of units) {
    if (!isPlaceholderStock(u.line.stockNumber) || !u.reported) continue;
    const box = closedBox(u.line.tracking);
    const left = box ? piecesLeft.get(u.line.tracking)![u.stock] : undefined;
    const i = left ? left.findIndex((p) => normaliseModel(p) === u.reported) : -1;
    if (i >= 0) {
      left!.splice(i, 1);
      result.set(u.key, { key: u.key, line: u.line, model: u.reported, sent: true, note: "" });
    }
  }
  for (const u of units) {
    if (result.has(u.key)) continue;
    const box = closedBox(u.line.tracking);
    const b = box ? budget.get(u.line.tracking)! : undefined;
    if (isPlaceholderStock(u.line.stockNumber)) {
      const piece = box ? piecesLeft.get(u.line.tracking)![u.stock]?.shift() : undefined;
      if (piece) {
        const model = normaliseModel(piece);
        const note = u.reported && model !== u.reported ? `Packed as ${model}, but the report's Model # said ${u.reported}.` : "";
        result.set(u.key, { key: u.key, line: u.line, model, sent: true, note });
        continue;
      }
      const model = u.reported || u.inName || null;
      // A box packed before its report ("Pack it anyway") has the watch as a
      // plain scan, not a piece: it went if that model was scanned into it.
      if (box && model && (b![model] ?? 0) > 0) {
        b![model] -= 1;
        result.set(u.key, { key: u.key, line: u.line, model, sent: true, note: "" });
        continue;
      }
      result.set(u.key, { key: u.key, line: u.line, model, sent: box?.status === "CLOSED_UNVERIFIED", note: "" });
      continue;
    }
    const model = normaliseModel(u.line.stockNumber);
    let sent = false;
    if (box?.status === "CLOSED_UNVERIFIED") sent = true;
    else if (box && (b![u.stock] ?? 0) > 0) {
      b![u.stock] -= 1;
      sent = true;
    }
    result.set(u.key, {
      key: u.key,
      line: u.line,
      model,
      sent,
      note: box && !sent ? "Its box was closed without this watch scanned into it." : "",
    });
  }

  // Scanned into a closed box, and no sale in it accounts for it: a watch that
  // went out with no sale behind it (an override, a box packed before its report).
  const strays: Stray[] = [];
  for (const [tracking, box] of boxes) {
    if (!CLOSED.includes(box.status) || box.status === "CLOSED_UNVERIFIED") continue;
    for (const [stock, n] of Object.entries(budget.get(tracking)!)) {
      if (n > 0 && !isPlaceholderStock(stock)) strays.push({ tracking, model: stock, qty: n });
    }
  }
  return { wanted: units.map((u) => result.get(u.key)!), strays };
}

/**
 * Where a sold watch comes off. A normal listing: the shelf, then its own
 * platform's sample, then the other's. A random pull: random pulls, then the
 * shelf when it has some, then the samples. When there is none anywhere it
 * still comes off — the first place goes below zero and is flagged, for the
 * next count to put right.
 */
export function choosePlace(
  balances: Record<Place, number>,
  platform: SalePlatform,
  randomPull: boolean,
): { place: Place; short: boolean } {
  const own: Place = platform === "EBAY" ? "SAMPLE_EBAY" : "SAMPLE_TIKTOK";
  const other: Place = platform === "EBAY" ? "SAMPLE_TIKTOK" : "SAMPLE_EBAY";
  const chain: Place[] = randomPull ? ["RANDOM_PULLS", "SELLABLE", own, other] : ["SELLABLE", own, other];
  const found = chain.find((p) => balances[p] > 0);
  return found ? { place: found, short: false } : { place: chain[0], short: true };
}

/**
 * What has to change, comparing the watches the reports say were sold with the
 * ones stock already took off.
 *
 * `balances` is what each model has now in each place; it is updated as
 * watches are given places, so ten sold of a model with six on the shelf take
 * six from the shelf and four from wherever is next.
 *
 * `sendsOnly` is for while taking sales off is switched off: nothing new comes
 * off and nothing is put back, but what is already waiting still leaves when
 * its box is packed — so turning it on again later never finds watches that
 * shipped meanwhile still "waiting".
 */
export function planDeduction(
  wanted: Wanted[],
  known: ReadonlyMap<string, KnownSale>,
  catalogue: ReadonlyMap<string, CatalogueEntry>,
  balances: Map<string, Record<Place, number>>,
  sendsOnly = false,
): Plan {
  const changes: Change[] = [];
  const unnamed: Wanted[] = [];
  const unknown: Wanted[] = [];
  const wantedKeys = new Set<string>();

  const sell = (w: Wanted, model: string, reuse: boolean) => {
    const b = balances.get(model) ?? { SELLABLE: 0, SAMPLE_EBAY: 0, SAMPLE_TIKTOK: 0, RANDOM_PULLS: 0, DAMAGED: 0 };
    const { place, short } = choosePlace(b, w.line.platform, isPlaceholderStock(w.line.stockNumber));
    b[place] -= 1;
    balances.set(model, b);
    const flags = [short ? "More sold than there was: it came off anyway, below zero, for the next count to put right." : "", w.note].filter(Boolean);
    changes.push({ kind: "sell", key: w.key, line: w.line, model, place, costCents: catalogue.get(model)?.costCents ?? null, sent: w.sent, flag: flags.join(" "), reuse });
  };
  const flag = (k: KnownSale, text: string) => {
    if (text && k.flag !== text) changes.push({ kind: "flag", key: k.key, flag: text });
  };

  const byHand = (k: KnownSale | undefined) => k !== undefined && (k.status === "CANCELLED" || k.status === "RETURNED");
  for (const w of wanted) {
    wantedKeys.add(w.key);
    const k = known.get(w.key);
    // Cancelled or returned by hand: the reports still list the sale, and must not take it off again.
    if (byHand(k)) continue;
    if (sendsOnly) {
      if (!k || k.status === "UNDONE") continue;
      if (k.status === "SOLD" && w.sent && w.model === k.model) changes.push({ kind: "send", key: k.key, model: k.model });
      if (k.status === "SENT" && !w.sent) changes.push({ kind: "unsend", key: k.key, model: k.model });
      continue;
    }
    if (w.model === null) {
      unnamed.push(w);
      // Named before (by a Model # since corrected away) and not sent: put it back.
      if (k && k.status === "SOLD") changes.push({ kind: "unsell", key: k.key, model: k.model, place: k.place });
      continue;
    }
    if (!catalogue.has(w.model)) {
      unknown.push(w);
      if (k && k.status === "SOLD") changes.push({ kind: "unsell", key: k.key, model: k.model, place: k.place });
      continue;
    }
    if (!k || k.status === "UNDONE") {
      sell(w, w.model, k !== undefined);
      continue;
    }
    if (k.model !== w.model) {
      if (k.status === "SENT") {
        flag(k, `Sent as ${k.model}, but the reports now say ${w.model}. Check which watch went.`);
        continue;
      }
      // Not sent yet: the right watch comes off instead (a corrected Model #, a scanned piece).
      changes.push({ kind: "unsell", key: k.key, model: k.model, place: k.place });
      const b = balances.get(k.model);
      if (b) b[k.place] += 1;
      sell(w, w.model, true);
      continue;
    }
    if (k.status === "SOLD" && w.sent) changes.push({ kind: "send", key: k.key, model: k.model });
    if (k.status === "SENT" && !w.sent) changes.push({ kind: "unsend", key: k.key, model: k.model });
    flag(k, w.note);
  }
  if (sendsOnly) return { changes, unnamed, unknown };

  // Taken off before, no longer in the reports (a corrected upload, a line
  // removed): put back — unless it has already gone out, which needs a person.
  for (const k of known.values()) {
    if (wantedKeys.has(k.key) || k.status === "UNDONE" || byHand(k)) continue;
    if (k.status === "SOLD") changes.push({ kind: "unsell", key: k.key, model: k.model, place: k.place });
    else flag(k, "Sent, but no longer in the reports (corrected or cancelled after it shipped). Check with the buyer: a return or a refund is step 4.");
  }
  return { changes, unnamed, unknown };
}

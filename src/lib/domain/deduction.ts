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
 *   - **Sent.** When its box is closed at packing, it leaves.
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
  status: "SOLD" | "SENT" | "UNDONE";
  flag: string;
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
  /** A random pull whose scanned piece is not the watch `Model #` named. */
  reportSaid: string | null;
}

export type Change =
  | { kind: "sell"; key: string; line: SaleLine; model: string; place: Place; costCents: number | null; sent: boolean; flag: string; reuse: boolean }
  | { kind: "unsell"; key: string; model: string; place: Place; wasSent: boolean }
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

/** The same order line in any upload is the same key; one key per watch. */
export const saleKey = (l: Pick<SaleLine, "platform" | "orderRef" | "lineRef">, unit: number) =>
  `${l.platform}|${l.orderRef}|${l.lineRef}|${unit}`;

const CLOSED: BoxStatus[] = ["CLOSED_COMPLETE", "CLOSED_INCOMPLETE", "CLOSED_UNVERIFIED"];

/**
 * Every watch the reports say was sold, one per unit, with its model and
 * whether its box has gone.
 *
 * A line in two uploads (overlapping downloads, a late eBay payer carried to
 * its show) is one line. In a box, the placeholder pieces scanned for a listing
 * are handed out to that listing's watches in order; a normal line's watches
 * count as sent as far as that stock number was scanned before the box closed
 * (all of them for a box closed complete, or marked sent without scanning).
 */
export function wantedSales(
  lines: SaleLine[],
  boxes: ReadonlyMap<string, BoxState>,
  isModel: (model: string) => boolean = () => false,
): Wanted[] {
  const seen = new Set<string>();
  const unique = lines.filter((l) => {
    const k = `${l.platform}|${l.orderRef}|${l.lineRef}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // A stable order, so pieces and scans are handed out the same way every time.
  unique.sort((a, b) => a.tracking.localeCompare(b.tracking) || a.orderRef.localeCompare(b.orderRef) || a.lineRef.localeCompare(b.lineRef));

  const handedOut = new Map<string, number>();
  const take = (tracking: string, stock: string) => {
    const k = `${tracking}|${stock}`;
    const n = handedOut.get(k) ?? 0;
    handedOut.set(k, n + 1);
    return n;
  };

  const out: Wanted[] = [];
  for (const line of unique) {
    const box = line.tracking ? boxes.get(line.tracking) : undefined;
    const closed = box !== undefined && CLOSED.includes(box.status);
    const stock = normaliseStockNumber(line.stockNumber);
    const placeholder = isPlaceholderStock(line.stockNumber);
    // Model # can name each watch of a line of two or more: "40022;45802".
    const named = line.modelNumber.split(/[;,/]/).map(normaliseModel).filter(Boolean);
    // A listing with a space that still names a real model ("Invicta 48912") is that model.
    const inName = placeholder ? (line.stockNumber.split(/[^0-9A-Za-z-]+/).map(normaliseModel).find((w) => w && isModel(w)) ?? "") : "";
    for (let unit = 0; unit < Math.max(1, line.qty); unit++) {
      const nth = take(line.tracking, stock);
      const reported = named[unit] ?? named[0] ?? "";
      if (placeholder) {
        const piece = box?.pieces[stock]?.[nth];
        const model = piece ? normaliseModel(piece) : reported || inName || null;
        out.push({
          key: saleKey(line, unit),
          line,
          model,
          // A random pull leaves only with its piece scanned — or in a box
          // marked sent without scanning, where nothing was scanned at all.
          sent: closed && (piece !== undefined || box!.status === "CLOSED_UNVERIFIED"),
          reportSaid: piece && reported && normaliseModel(piece) !== reported ? reported : null,
        });
      } else {
        const scanned = box?.scanned[stock] ?? 0;
        out.push({
          key: saleKey(line, unit),
          line,
          model: normaliseModel(line.stockNumber),
          sent: closed && (box!.status !== "CLOSED_INCOMPLETE" || nth < scanned),
          reportSaid: null,
        });
      }
    }
  }
  return out;
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
 */
export function planDeduction(
  wanted: Wanted[],
  known: ReadonlyMap<string, KnownSale>,
  catalogue: ReadonlyMap<string, CatalogueEntry>,
  balances: Map<string, Record<Place, number>>,
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
    const flags = [
      short ? "More sold than there was: it came off anyway, below zero, for the next count to put right." : "",
      w.reportSaid ? `Packed as ${model}, but the report's Model # said ${w.reportSaid}.` : "",
    ].filter(Boolean);
    changes.push({ kind: "sell", key: w.key, line: w.line, model, place, costCents: catalogue.get(model)?.costCents ?? null, sent: w.sent, flag: flags.join(" "), reuse });
  };

  for (const w of wanted) {
    wantedKeys.add(w.key);
    const k = known.get(w.key);
    if (w.model === null) {
      unnamed.push(w);
      // Named before (by a Model # since corrected away) and not sent: put it back.
      if (k && k.status === "SOLD") changes.push({ kind: "unsell", key: k.key, model: k.model, place: k.place, wasSent: false });
      continue;
    }
    if (!catalogue.has(w.model)) {
      unknown.push(w);
      if (k && k.status === "SOLD") changes.push({ kind: "unsell", key: k.key, model: k.model, place: k.place, wasSent: false });
      continue;
    }
    if (!k || k.status === "UNDONE") {
      sell(w, w.model, k !== undefined);
      continue;
    }
    if (k.model !== w.model) {
      if (k.status === "SENT") {
        const flag = `Sent as ${k.model}, but the reports now say ${w.model}. Check which watch went.`;
        if (k.flag !== flag) changes.push({ kind: "flag", key: k.key, flag });
        continue;
      }
      // Not sent yet: the right watch comes off instead (a corrected Model #, a scanned piece).
      changes.push({ kind: "unsell", key: k.key, model: k.model, place: k.place, wasSent: false });
      const b = balances.get(k.model);
      if (b) b[k.place] += 1;
      sell(w, w.model, true);
      continue;
    }
    if (k.status === "SOLD" && w.sent) changes.push({ kind: "send", key: k.key, model: k.model });
    if (k.status === "SENT" && !w.sent) changes.push({ kind: "unsend", key: k.key, model: k.model });
    const flag = w.reportSaid ? `Packed as ${w.model}, but the report's Model # said ${w.reportSaid}.` : "";
    if (flag && k.flag !== flag) changes.push({ kind: "flag", key: k.key, flag });
  }

  // Taken off before, no longer in the reports (a corrected upload, a line
  // removed): put back — unless it has already gone out, which needs a person.
  for (const k of known.values()) {
    if (wantedKeys.has(k.key) || k.status === "UNDONE") continue;
    if (k.status === "SOLD") {
      changes.push({ kind: "unsell", key: k.key, model: k.model, place: k.place, wasSent: false });
    } else {
      const flag = "Sent, but no longer in the reports (corrected or cancelled after it shipped). Check with the buyer: a return or a refund is step 4.";
      if (k.flag !== flag) changes.push({ kind: "flag", key: k.key, flag });
    }
  }
  return { changes, unnamed, unknown };
}

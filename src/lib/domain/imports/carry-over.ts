/**
 * Sales in this morning's report that belong to the day before.
 *
 * eBay's order report lists what was *paid* in its window, and a buyer who wins
 * in the night show and pays after midnight lands in the next morning's export.
 * On 10/01 one such order — sold in the 09/29 night show, paid 09/30 — sent the
 * whole 09/30 eBay report back as "two different show days", so 372 orders
 * could not be packed for want of one.
 *
 * That order is not a mistake to refuse. It sold in the previous day's show, so
 * that show's pair are paid for it and it belongs on that day's report; it is
 * here only because of when the buyer paid. So it is carried: taken out of this
 * upload, and added to the previous day's eBay report (see `lib/server/imports`).
 *
 * Narrow on purpose. Two days' files dropped in together are still refused —
 * that is the mistake the one-day rule exists for — and what tells the two
 * apart is the payment date: a straggler was paid on this report's day, while
 * a whole earlier report's orders were paid on the day before.
 *
 * Pure, so the rule can be tested on its own.
 */

import { addDays } from "../dates";
import type { DateISO } from "../types";
import { parseShiftTag } from "./types";
import type { WatchSale } from "./types";

export interface CarryOver {
  /** What this upload keeps — one day, unless something else is wrong. */
  kept: WatchSale[];
  /** Whole orders from the day before, to be added to that day's eBay report. */
  carried: WatchSale[];
  /**
   * Orders from the day before that share a label with one of this day's.
   *
   * A label is one box, and a box is on one day, so moving these would split a
   * parcel across two days and the packer would never be asked for the late
   * piece. They stay on this day instead — in \`kept\`, dated this day — so the
   * box is whole, at the cost of their commission going to this day's show.
   * Listed here so the upload can say so.
   */
  keptToday: WatchSale[];
}

/**
 * eBay orders checked out after midnight, read back to the show they sold in.
 *
 * eBay dates an order by its checkout. A buyer who wins several watches in the
 * night show and checks out for all of them after midnight gets an order dated
 * the next day — on 10/06, record 37378: four watches tagged "10.05.26 PM",
 * dated 10/06. Read by that date, the report covered two days and the whole
 * morning was refused.
 *
 * The show tag on each item says which show it sold in, so it is believed —
 * but only in exactly this shape: the order is dated the day after the rest of
 * the report, every one of its items is tagged with the report's day, and the
 * report really does hold that day. Anything else dated another day is left
 * for the one-day rule, as before.
 */
export function lateCheckouts(sales: readonly WatchSale[]): { sales: WatchSale[]; redated: WatchSale[] } {
  const dates = new Set(sales.map((s) => s.showDate));
  if (dates.size < 2) return { sales: [...sales], redated: [] };

  const byOrder = new Map<string, WatchSale[]>();
  for (const s of sales) {
    if (s.platform !== "EBAY") continue;
    const list = byOrder.get(s.orderRef) ?? [];
    list.push(s);
    byOrder.set(s.orderRef, list);
  }

  const moveTo = new Map<string, DateISO>();
  for (const [order, lines] of byOrder) {
    const dated = lines[0].showDate;
    if (!lines.every((l) => l.showDate === dated)) continue;
    const dayBefore = addDays(dated, -1);
    const taggedDayBefore = lines.every((l) => l.shiftTagValid && parseShiftTag(l.shiftTag)?.dateISO === dayBefore);
    // The report has to be that day's: other orders in it carry that date.
    const reportIsThatDay = sales.some((s) => s.orderRef !== order && s.showDate === dayBefore);
    if (taggedDayBefore && reportIsThatDay) moveTo.set(order, dayBefore);
  }
  if (moveTo.size === 0) return { sales: [...sales], redated: [] };

  const redated: WatchSale[] = [];
  const out = sales.map((s) => {
    const to = s.platform === "EBAY" ? moveTo.get(s.orderRef) : undefined;
    if (!to) return s;
    const moved = { ...s, showDate: to };
    redated.push(moved);
    return moved;
  });
  return { sales: out, redated };
}

/** An order paid on a later day than the show it sold in. */
export const paidLate = (s: WatchSale) => s.paidOn !== null && s.paidOn > s.showDate;

export function carryOver(sales: readonly WatchSale[]): CarryOver {
  const dates = new Set(sales.map((s) => s.showDate));
  if (dates.size < 2) return { kept: [...sales], carried: [], keptToday: [] };

  /*
    The report's own day is the latest it holds.

    Not the day most of its rows are for: a small report — a diamond eBay with
    one sale and one late payer — has no majority, and which day "won" came
    down to the order of the rows. A late payer is always from before the
    report's day, so the latest day is the report's.
  */
  const day = [...dates].sort().at(-1) as DateISO;
  const before = addDays(day, -1);

  const late = (s: WatchSale) =>
    s.platform === "EBAY" && s.showDate === before && s.paidOn !== null && s.paidOn >= day;

  // Whole orders only. An order with any line that does not qualify stays
  // where it is, and the one-day rule then speaks for it.
  const byOrder = new Map<string, WatchSale[]>();
  for (const s of sales) {
    if (s.showDate !== before || s.platform !== "EBAY") continue;
    const list = byOrder.get(s.orderRef) ?? [];
    list.push(s);
    byOrder.set(s.orderRef, list);
  }
  const lateOrders = new Set(
    [...byOrder.entries()].filter(([, lines]) => lines.every(late)).map(([order]) => order),
  );
  if (lateOrders.size === 0) return { kept: [...sales], carried: [], keptToday: [] };

  const isLate = (s: WatchSale) =>
    s.platform === "EBAY" && s.showDate === before && lateOrders.has(s.orderRef);

  const keptTracking = new Set(
    sales.filter((s) => !isLate(s) && s.tracking !== "").map((s) => s.tracking),
  );
  const sharesLabel = new Set(
    sales.filter((s) => isLate(s) && keptTracking.has(s.tracking)).map((s) => s.orderRef),
  );

  const keptToday = sales.filter((s) => isLate(s) && sharesLabel.has(s.orderRef));
  return {
    kept: [
      ...sales.filter((s) => !isLate(s)),
      ...keptToday.map((s) => ({ ...s, showDate: day })),
    ],
    carried: sales.filter((s) => isLate(s) && !sharesLabel.has(s.orderRef)),
    keptToday,
  };
}

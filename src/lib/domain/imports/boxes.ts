/**
 * Turning paid watches into boxes, and checking the result is sane.
 *
 * A box is a tracking number: one number, one physical parcel, one buyer.
 * Several orders share one when a buyer bought more than once during a show —
 * that is a combined shipment and it is still one box.
 *
 * Tracking is the key rather than TikTok's explicit `Package ID` for two
 * reasons: eBay has no package column at all, and the tracking number is the
 * only thing a packer can actually scan. On the 09/08 exports the two agreed
 * exactly — 146 package ids, 146 tracking numbers, no split either way.
 *
 * Contents are counts per stock number, never a list of unique items. A real
 * box on 09/08 held `49746` three times and `48080` twice. A tick-list would
 * reject the second scan of an identical barcode and strand the packer holding
 * a watch the system says should not exist.
 */

import type { DateISO } from "../types";
import { findSuffixCollisions, normaliseStockNumber, trackingCarrier } from "./tracking";
import type { ImportFlag, ImportPlatform, ShowKey, WatchSale } from "./types";

export interface BoxItem {
  stockNumber: string;
  expected: number;
}

export interface Box {
  tracking: string;
  platform: ImportPlatform;
  buyer: string;
  shipToName: string;
  state: string;
  showDate: DateISO;
  /** Usually one. A box can legitimately span both of a day's shows. */
  shows: ShowKey[];
  items: BoxItem[];
  /** Total watches expected in the box. */
  watchCount: number;
  /** Every order that put something in this box. */
  orderRefs: string[];
}

/**
 * The parts of a sale a box is built from.
 *
 * Narrower than a whole `WatchSale` so boxes can also be rebuilt from what is
 * already stored — which is what happens when one of a day's files is uploaded
 * again. A box can hold watches from two shows, so working out what belongs in
 * it means looking at the day's other reports too, not just the file in hand.
 */
export type BoxSource = Pick<
  WatchSale,
  | "tracking"
  | "platform"
  | "buyer"
  | "shipToName"
  | "state"
  | "showDate"
  | "show"
  | "stockNumber"
  | "qty"
  | "orderRef"
>;

/** Groups paid watches into the boxes they will ship in. */
export function buildBoxes(sales: readonly BoxSource[]): Box[] {
  const byTracking = new Map<string, BoxSource[]>();
  for (const sale of sales) {
    if (sale.tracking === "") continue;
    const existing = byTracking.get(sale.tracking);
    if (existing) existing.push(sale);
    else byTracking.set(sale.tracking, [sale]);
  }

  const boxes: Box[] = [];
  for (const [tracking, group] of byTracking) {
    const counts = new Map<string, number>();
    for (const sale of group) {
      const key = normaliseStockNumber(sale.stockNumber);
      counts.set(key, (counts.get(key) ?? 0) + (sale.qty || 1));
    }

    const first = group[0];
    boxes.push({
      tracking,
      platform: first.platform,
      buyer: first.buyer,
      // Blank on an eBay item row until the summary supplies it; take whichever
      // row in the box actually has one.
      shipToName: group.find((s) => s.shipToName !== "")?.shipToName ?? "",
      state: group.find((s) => s.state !== "")?.state ?? "",
      showDate: first.showDate,
      shows: [...new Set(group.map((s) => s.show))].sort(),
      items: [...counts.entries()]
        .map(([stockNumber, expected]) => ({ stockNumber, expected }))
        .sort((a, b) => a.stockNumber.localeCompare(b.stockNumber)),
      watchCount: group.reduce((n, s) => n + (s.qty || 1), 0),
      orderRefs: [...new Set(group.map((s) => s.orderRef))],
    });
  }

  return boxes.sort((a, b) => a.tracking.localeCompare(b.tracking));
}

/**
 * The checks that run on every import.
 *
 * A blocking issue means the files are not what the code was written for, and
 * producing a box list from them would be worse than producing nothing: a
 * packer would be told to put the wrong watches in a parcel. Warnings describe
 * things worth knowing that do not make the data untrustworthy.
 *
 * Verified passing on the real 09/08 exports — 473 watches in 220 boxes.
 */
export function checkIntegrity(sales: readonly WatchSale[], boxes: readonly Box[]): ImportFlag[] {
  const flags: ImportFlag[] = [];

  /*
    A paid watch with no label yet is not a fault in the file.

    The eBay report is downloaded early in the morning, and an order whose label
    has not been bought by then has no tracking number. On 09/14 that was one $24
    watch, and refusing the upload for it held back the other 590, every box and
    the whole day's sales. So it is imported: the sale counts, no box is made for
    it, and uploading the day again once the label exists adds its box without
    touching anything already packed.
  */
  const noTracking = sales.filter((s) => s.tracking === "");
  if (noTracking.length > 0) {
    const orders = [...new Map(noTracking.map((s) => [s.orderRef, s])).values()];
    flags.push({
      severity: "warning",
      message:
        `${noTracking.length} paid watch(es) have no shipping label yet, so no box was made for them: ` +
        orders
          .slice(0, 5)
          .map((s) => `order ${s.orderRef} (${s.stockNumber})`)
          .join(", ") +
        (orders.length > 5 ? ` and ${orders.length - 5} more` : "") +
        `. Their sales are counted. Once the label is bought, download the report again and upload ` +
        `all of the day's files again — the box is added and nothing already packed is touched.`,
    });
  }

  const noStock = sales.filter((s) => s.stockNumber.trim() === "");
  if (noStock.length > 0) {
    flags.push({
      severity: "blocking",
      message: `${noStock.length} paid watch(es) have no stock number, so a packer could not scan them. First: order ${noStock[0].orderRef}.`,
    });
  }

  const byTracking = new Map<string, BoxSource[]>();
  for (const sale of sales) {
    if (sale.tracking === "") continue;
    const existing = byTracking.get(sale.tracking);
    if (existing) existing.push(sale);
    else byTracking.set(sale.tracking, [sale]);
  }

  for (const [tracking, group] of byTracking) {
    const buyers = new Set(group.map((s) => s.buyer));
    if (buyers.size > 1) {
      flags.push({
        severity: "blocking",
        message: `Box ${tracking} contains orders from ${buyers.size} different buyers (${[...buyers].join(", ")}). One parcel goes to one person.`,
      });
    }
    const platforms = new Set(group.map((s) => s.platform));
    if (platforms.size > 1) {
      flags.push({
        severity: "blocking",
        message: `Box ${tracking} mixes ${[...platforms].join(" and ")} orders. A tracking number belongs to one marketplace.`,
      });
    }
  }

  // Suffix matching is what lets a scanned label resolve without parsing its
  // routing prefix. It is only safe while no tracking number ends with another.
  const collisions = findSuffixCollisions(boxes.map((b) => b.tracking));
  if (collisions.length > 0) {
    flags.push({
      severity: "warning",
      message: `${collisions.length} tracking number(s) end with another tracking number (e.g. ${collisions[0][0]} ends with ${collisions[0][1]}). Scanned labels for these must be matched exactly, not by suffix.`,
    });
  }

  // Every tracking number should be a shape a carrier really uses. This used to
  // expect 22 digits throughout, and warned on every upload once TikTok began
  // sending small parcels with GOFO. A shape no carrier has used is most likely
  // a column that changed meaning, and worth checking before anybody packs.
  const unfamiliar = boxes.filter((b) => trackingCarrier(b.tracking) === null);
  if (unfamiliar.length > 0) {
    flags.push({
      severity: "warning",
      message:
        `${unfamiliar.length} tracking number(s) are in a format not seen before (e.g. ${unfamiliar[0].tracking}). ` +
        `Expected USPS (22 digits) or GOFO (GFUS and 14 digits). Check that one of those labels scans before packing.`,
    });
  }

  /* ------------------------------------------------- the arithmetic (F5) */

  // Checked per order, not per row: an eBay multi-item order carries its
  // shipping, tax and total on the first watch only, so a per-row check would
  // fail on every continuation line by design.
  const byOrder = new Map<string, WatchSale[]>();
  for (const sale of sales) {
    const key = `${sale.platform}|${sale.orderRef}`;
    const existing = byOrder.get(key);
    if (existing) existing.push(sale);
    else byOrder.set(key, [sale]);
  }

  const mismatches: string[] = [];
  const pennies: string[] = [];
  for (const [key, group] of byOrder) {
    const total = group.reduce((n, s) => n + s.orderTotal, 0);
    if (total === 0) continue; // nothing claimed, nothing to reconcile
    const parts = group.reduce((n, s) => n + s.netItemPrice + s.shipping + s.taxAndFees, 0);
    const gap = Math.abs(parts - total);
    if (gap <= 0.01) continue;
    const line = `${key.split("|")[1]} (${parts.toFixed(2)} vs ${total.toFixed(2)})`;
    // Up to 50 cents is a fee the platform adds to the total without a column of
    // its own. eBay 30574 on 09/14 was 31 cents over, shipped to Colorado, whose
    // retail delivery fee is that size. It is not revenue and changes nothing.
    if (gap <= 0.5) pennies.push(line);
    else mismatches.push(line);
  }
  if (pennies.length > 0) {
    flags.push({
      severity: "info",
      message:
        `${pennies.length} order(s) differ from their order total by 50 cents or less — usually a state delivery ` +
        `fee the platform adds to the total without a column of its own. Revenue is unaffected. ` +
        pennies.slice(0, 3).join("; "),
    });
  }
  if (mismatches.length > 0) {
    flags.push({
      severity: "warning",
      message:
        `${mismatches.length} order(s) do not add up — item + shipping + tax should equal the order total. ` +
        `The platform has changed something; the figures are reported as they came, not corrected. ` +
        mismatches.slice(0, 3).join("; "),
    });
  }

  return flags;
}

export interface DaySummary {
  watches: number;
  boxes: number;
  byShow: { show: ShowKey; watches: number }[];
  byPlatform: { platform: ImportPlatform; watches: number; boxes: number }[];
  /** Boxes holding watches from more than one show — normal, and why the box list is per day. */
  boxesSpanningShows: number;
  largestBox: number;
}

export function summariseDay(sales: readonly WatchSale[], boxes: readonly Box[]): DaySummary {
  const showCounts = new Map<ShowKey, number>();
  for (const sale of sales) {
    showCounts.set(sale.show, (showCounts.get(sale.show) ?? 0) + (sale.qty || 1));
  }

  const platforms: ImportPlatform[] = ["TIKTOK", "EBAY"];

  return {
    watches: sales.reduce((n, s) => n + (s.qty || 1), 0),
    boxes: boxes.length,
    byShow: [...showCounts.entries()]
      .map(([show, watches]) => ({ show, watches }))
      .sort((a, b) => a.show.localeCompare(b.show)),
    byPlatform: platforms.map((platform) => ({
      platform,
      watches: sales.filter((s) => s.platform === platform).reduce((n, s) => n + (s.qty || 1), 0),
      boxes: boxes.filter((b) => b.platform === platform).length,
    })),
    boxesSpanningShows: boxes.filter((b) => b.shows.length > 1).length,
    largestBox: boxes.reduce((max, b) => Math.max(max, b.watchCount), 0),
  };
}

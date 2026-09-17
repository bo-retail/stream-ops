/**
 * Reading an eBay orders export (F3).
 *
 * Harder than TikTok in three ways.
 *
 * The layout is not a clean table: a row of bare commas, then the header, then
 * an all-empty row, then the data, then a blank line and two footer lines.
 *
 * A multi-item order is written as a summary row followed by one row per watch.
 * The summary carries the buyer, the address and the order's money; the item
 * rows carry the watches and the tracking. Neither is complete on its own, and
 * the summary's `Sold For` is the sum of its children — counting it would
 * double the order (R8).
 *
 * And the file cannot say which show a row sold in: one file holds every eBay
 * show of the day and carries no time of day. So on eBay, and only on eBay, the
 * `Custom Label` tag decides the show (R15) — the exact reverse of TikTok.
 */

import type { DateISO } from "../types";
import { checkHeaders, isBlankRow, parseCsv, toRecords } from "./csv";
import { EBAY_HEADERS, defaultShiftTag, parseMoney, parseShiftTag } from "./types";
import type { DroppedRow, ImportFlag, ParseResult, ShowKey, WatchSale } from "./types";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** `Sep-07-26`. Date only — eBay records no time, so nothing can be timed within a show. */
export function parseEbayDate(raw: string): DateISO | null {
  const match = /^([A-Za-z]{3})-(\d{1,2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (!month) return null;
  const day = Number(match[2]);
  if (day < 1 || day > 31) return null;
  return `20${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface EbayFile {
  name: string;
  text: string;
}

/**
 * Separates the real table from eBay's decoration.
 *
 * The two empty-looking things in the file are not the same and must not be
 * treated alike: line 3 is an empty *data* row with all 82 fields present and
 * blank, and is dropped; the line before the footer is a genuinely blank line
 * of one empty field, and it ends the table. Telling them apart by width is
 * what stops the parser stopping at line 3 and reading nothing.
 */
function locateTable(rows: string[][]): { header: string[]; data: string[][]; footer: string[][] } {
  const header = rows[1] ?? [];
  const data: string[][] = [];
  let i = 2;

  for (; i < rows.length; i++) {
    const row = rows[i];
    if (row.length <= 5) break; // blank line, or a footer line — the table is over
    if (isBlankRow(row)) continue; // the all-empty placeholder row
    data.push(row);
  }

  return { header, data, footer: rows.slice(i) };
}

export function parseEbayFile(file: EbayFile): ParseResult {
  const flags: ImportFlag[] = [];
  const rows = parseCsv(file.text);

  if (rows.length < 3) {
    return { sales: [], dropped: [], flags: [{ severity: "blocking", message: `${file.name} is empty.` }] };
  }

  const { header, data, footer } = locateTable(rows);

  const headerCheck = checkHeaders(header, EBAY_HEADERS);
  if (!headerCheck.ok) {
    return {
      sales: [],
      dropped: [],
      flags: [
        {
          severity: "blocking",
          message: `${file.name}: the eBay export has changed shape — ${headerCheck.problems[0]}. No figures produced.`,
        },
      ],
    };
  }
  if (headerCheck.extra.length > 0) {
    flags.push({
      severity: "warning",
      message: `${file.name}: ${headerCheck.extra.length} new column(s) appended (${headerCheck.extra.join(", ")}). Ignored.`,
    });
  }

  const records = toRecords(header, data).filter((r) => r["Sales Record Number"] !== "");

  /* ---------------------------------------------------------- groups (R7) */

  const groups = new Map<string, Record<string, string>[]>();
  for (const record of records) {
    const key = record["Sales Record Number"];
    const existing = groups.get(key);
    if (existing) existing.push(record);
    else groups.set(key, [record]);
  }

  // The footer's count is the number of sales records, not the number of rows.
  const footerCount = footer
    .map((row) => (row[1] ?? "").toLowerCase().includes("record(s) downloaded") ? Number(row[0]) : NaN)
    .find((n) => Number.isFinite(n));
  if (footerCount !== undefined && footerCount !== groups.size) {
    flags.push({
      severity: "warning",
      message: `${file.name}: the footer says ${footerCount} records but ${groups.size} were read.`,
    });
  }

  const sales: WatchSale[] = [];
  const dropped: DroppedRow[] = [];
  const malformedTags: string[] = [];
  const saleDates = new Set<DateISO>();

  for (const [srn, group] of groups) {
    // Paid if ANY row in the group carries a Paid On Date. A summary row exists
    // only for a paid multi-item order; a never-checked-out commitment has no
    // order number, no address and no shipment — but none of those decide it.
    const paidRow = group.find((r) => r["Paid On Date"] !== "");
    const items = group.filter((r) => r["Item Number"] !== "");
    const summary = group.find((r) => r["Item Number"] === "");

    if (!paidRow) {
      for (const row of items.length > 0 ? items : group) {
        dropped.push({
          sourceFile: file.name,
          platform: "EBAY",
          orderRef: srn,
          buyer: row["Buyer Username"],
          stockNumber: row["Item Title"],
          amount: parseMoney(row["Sold For"]),
          reason: "committed but never paid",
        });
      }
      continue;
    }

    if (summary) {
      dropped.push({
        sourceFile: file.name,
        platform: "EBAY",
        orderRef: srn,
        buyer: summary["Buyer Username"],
        stockNumber: "",
        amount: parseMoney(summary["Sold For"]),
        reason: `summary row of a ${items.length}-item order — used only to confirm payment, not counted`,
      });
    }

    // Order-level money, the buyer and the address live on the summary row when
    // there is one, and on the single row when there is not.
    const orderSource = summary ?? items[0];
    if (!orderSource) continue;

    const showDate = parseEbayDate(orderSource["Sale Date"]) ?? parseEbayDate(paidRow["Sale Date"]);
    if (showDate) saleDates.add(showDate);
    const paidOn = parseEbayDate(paidRow["Paid On Date"]);

    items.forEach((item, index) => {
      const rawTag = item["Custom Label"];
      const parsedTag = parseShiftTag(rawTag);
      const date = showDate ?? paidOn ?? "";

      if (!parsedTag) {
        malformedTags.push(`${srn} (${item["Item Title"]}, ${item["Sold For"]})`);
      }

      // On eBay the tag decides the show (R15), because one file carries both
      // the day and the night show and records no time of day. A bad tag leaves
      // nothing else to go on, so it is credited to PM and flagged loudly. That
      // cost nothing while eBay ran nights only; with the day show back, a
      // day-show watch with a bad tag pays the night pair until the listing is
      // fixed and the day uploaded again.
      const half: "AM" | "PM" = parsedTag ? parsedTag.half : "PM";
      const show: ShowKey = half === "AM" ? "eBay AM" : "eBay PM";

      // Order-level figures sit on the first watch only, so an order's shipping
      // and tax are never counted once per item.
      const first = index === 0;

      sales.push({
        /*
          eBay names no seller account anywhere in its 82 columns, so a file
          cannot say whose it is. Only watches sell on eBay, so that is what an
          eBay file is — and the day diamonds start selling there, this is the
          line that has to change first, because nothing else could tell two
          eBay exports apart.
        */
        business: "WATCH",
        platform: "EBAY",
        show,
        showDate: date,
        shiftTag: parsedTag ? rawTag : defaultShiftTag(date, "PM"),
        rawShiftTag: rawTag,
        shiftTagValid: parsedTag !== null,

        orderRef: srn,
        lineRef: item["Transaction ID"],
        buyer: item["Buyer Username"] || orderSource["Buyer Username"],
        stockNumber: item["Item Title"],
        category: "",
        qty: Number(item["Quantity"]) || 1,

        unitPrice: parseMoney(item["Sold For"]),
        platformDiscount: 0,
        sellerDiscount: 0,
        netItemPrice: parseMoney(item["Sold For"]),
        shipping: first ? parseMoney(orderSource["Shipping And Handling"]) : 0,
        taxAndFees: first ? parseMoney(orderSource["eBay Collected Tax"]) : 0,
        orderTotal: first ? parseMoney(orderSource["Total Price"]) : 0,

        createdAt: null, // eBay records no time of day
        paidOn,

        shipToName: orderSource["Ship To Name"],
        state: orderSource["Ship To State"],
        paymentMethod: "", // always blank on eBay, on every row type

        packageId: "", // eBay has no package column — tracking is the only grouping
        tracking: item["Tracking Number"],
        sourceFile: file.name,
      });
    });
  }

  if (malformedTags.length > 0) {
    flags.push({
      severity: "warning",
      message:
        `${file.name}: ${malformedTags.length} eBay row(s) had an unreadable Custom Label and were credited to the PM show. ` +
        `eBay has no time of day to tell a day-show sale from a night-show one, so if any of these sold in the day ` +
        `show its commission is going to the night pair — fix the listing and upload the day again. ` +
        malformedTags.slice(0, 3).join("; "),
    });
  }

  if (saleDates.size > 1) {
    flags.push({
      severity: "warning",
      message: `${file.name}: rows carry ${saleDates.size} different Sale Dates (${[...saleDates].join(", ")}). One file should be one day.`,
    });
  }

  /* -------------------------------------------------- record-number gaps (R11) */

  const numbers = [...groups.keys()].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (numbers.length > 1) {
    const missing: number[] = [];
    for (let n = numbers[0]; n <= numbers[numbers.length - 1]; n++) {
      if (!groups.has(String(n))) missing.push(n);
    }
    if (missing.length > 0) {
      flags.push({
        severity: "info",
        message: `${file.name}: sales record numbers absent from the sequence: ${missing.join(", ")}. Flagged for manual lookup only.`,
      });
    }
  }

  return { sales, dropped, flags };
}

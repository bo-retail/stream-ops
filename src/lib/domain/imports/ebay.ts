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

import type { Business } from "../business";
import type { DateISO } from "../types";
import {
  checkHeaders,
  isBlankRow,
  notedRoundingMessage,
  parseCsv,
  roundedOffColumns,
  roundedOffMessage,
  toRecords,
} from "./csv";
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
  /*
    The header is found rather than assumed to be the second line.

    eBay's own export puts a row of bare commas above it, but a file that has
    been opened and saved again — which is what happens when a sample show's
    stock numbers are typed in — no longer has that row, and the header is the
    first line. Reading line 2 there took the first order as the column names
    and stopped the whole upload with "the export has changed shape".
  */
  // The same test `detectPlatform` makes, on the same window. That one runs
  // first, so anything looser here would only describe files it already turned
  // away — and the two drifting apart is how an edited report came to be
  // refused as "neither a TikTok nor an eBay export".
  const headerIndex = rows
    .slice(0, 5)
    .findIndex((row) => (row[0] ?? "").trim() === "Sales Record Number");
  const start = headerIndex === -1 ? 1 : headerIndex;
  const header = rows[start] ?? [];
  const data: string[][] = [];
  let i = start + 1;

  for (; i < rows.length; i++) {
    const row = rows[i];
    if (row.length <= 5) break; // blank line, or a footer line — the table is over
    /*
      A footer padded out to the full width.

      Saving the file again fills every short row to 82 fields, so the two
      footer lines stop being recognisable by their width. "310" in the first
      column would then be read as an order with a sales record number of 310.
    */
    if (isFooterRow(row)) break;
    if (isBlankRow(row)) continue; // the all-empty placeholder row
    data.push(row);
  }

  return { header, data, footer: rows.slice(i) };
}

/**
 * The columns that hold numbers too long for a spreadsheet to keep whole.
 *
 * Only these are checked for that damage. Everything else in the file is text
 * somebody wrote — `Item Title` carries the stock number — and refusing a whole
 * day because a listing was called "5E+3" would be worse than the thing being
 * guarded against.
 */
const EBAY_LONG_NUMBER_COLUMNS = ["Tracking Number", "Sales Record Number"] as const;

/**
 * Long numbers that are only ever written down, never acted on.
 *
 * `Item Number` decides nothing but whether a row is an order's summary or one
 * of its watches, which is a question of whether the cell is empty — a rounded
 * one still answers it. `Transaction ID` is kept against the line and read by
 * nothing. Losing them costs a little detail in the record and nothing else.
 *
 * Worth saying out loud, because refusing the file over these is what happened
 * on 09/24: the day's stock numbers had been typed in by hand, the tracking
 * numbers were all intact, and the upload was turned away over two columns that
 * change nothing. A day of somebody's work, refused for tidiness.
 */
const EBAY_NOTED_NUMBER_COLUMNS = ["Item Number", "Transaction ID", "Order Number"] as const;

/**
 * `9/8/2026 12:00:00 PM` — a date a spreadsheet wrote, not a tag anyone typed.
 *
 * Unreadable on its own does not mean a spreadsheet did it. A tag is typed once
 * into a listing template and copied across the show, so one typo — `9.8.26 PM`,
 * `09/08/26 PM` — makes every tag on a small day unreadable too. That is a
 * warning the floor can act on, and refusing it would be worse than useless:
 * downloading the report again returns the same label, because the label is
 * what the listing really says. Only the shape below is Excel's doing, and only
 * that is refused.
 */
function looksLikeSpreadsheetDateTime(raw: string): boolean {
  return /^\d{1,2}\/\d{1,2}\/\d{2,4}(\s|,|$)/.test(raw.trim());
}

/** eBay signs off with a count and the seller's id, whatever the row width. */
function isFooterRow(row: string[]): boolean {
  return (
    row.slice(0, 3).some((cell) => /record\(s\) downloaded/i.test(cell)) ||
    /^Seller ID\s*:/i.test(row[0] ?? "")
  );
}

/**
 * @param business Whose report this is. The file cannot say — eBay names no
 *   seller in any of its 82 columns — so the caller resolves it from the
 *   schedule. See `placeEbayFile`. Defaults to watches, the only business that
 *   has ever sold on eBay, so every existing caller reads exactly as before.
 */
export function parseEbayFile(file: EbayFile, business: Business = "WATCH"): ParseResult {
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

  /*
    What a spreadsheet does to a file that has been opened and saved.

    Two kinds of damage, both silent and neither recoverable from the file
    itself, so each is refused rather than worked around: long numbers rounded
    off, and dates rewritten into a form eBay never writes.
  */
  const damaged = roundedOffColumns(records, EBAY_LONG_NUMBER_COLUMNS);
  if (damaged.length > 0) {
    return { sales: [], dropped: [], flags: [...flags, { severity: "blocking", message: roundedOffMessage(file.name, damaged) }] };
  }

  const noted = roundedOffColumns(records, EBAY_NOTED_NUMBER_COLUMNS);
  if (noted.length > 0) flags.push({ severity: "warning", message: notedRoundingMessage(file.name, noted) });

  /*
    `Sep-08-26` rewritten as `9/8/2026`.

    Excel reads that column as dates and writes them back in its own format.
    Nothing downstream could read them: every row came out with no show date at
    all, the day landed as an empty string, and the upload died several steps
    later with "Invalid date" — a message about neither the file nor the fix.
  */
  const DATE_COLUMNS = ["Sale Date", "Paid On Date"] as const;
  const badDates = records.flatMap((r) =>
    DATE_COLUMNS.filter((c) => r[c] !== "" && parseEbayDate(r[c]) === null).map((c) => ({
      column: c,
      value: r[c],
    })),
  );
  // Any unreadable date is damage: eBay writes Mon-DD-YY on every row of every
  // report, so there is no file where some are readable and some are not.
  const noDateAtAll =
    records.length > 0 && !records.some((r) => DATE_COLUMNS.some((c) => parseEbayDate(r[c]) !== null));
  if (badDates.length > 0 || noDateAtAll) {
    return {
      sales: [],
      dropped: [],
      flags: [
        ...flags,
        {
          severity: "blocking",
          message:
            `${file.name}: ` +
            (badDates.length > 0
              ? `the ${badDates[0].column} column reads "${badDates[0].value}" instead of the form eBay ` +
                `writes (Sep-08-26), on ${badDates.length} row(s). A spreadsheet has rewritten the dates`
              : `no row carries a date this can read`) +
            `, so there is no way to tell which show day this is. Nothing was imported. ` +
            `Download the report again, and if it needs editing, open it in Google Sheets (File, Import, and ` +
            `turn off "Convert text to numbers"), or in Excel use Data, From Text/CSV and set every column to Text.`,
        },
      ],
    };
  }

  /*
    The show tag, converted into a date-time.

    `09.08.26 PM` is a date to a spreadsheet, and it comes back as
    `9/8/2026 12:00:00 PM`. On eBay this tag is the only thing separating the
    day show from the night one, so every row would fall to PM and the whole
    day's commission would go to the night pair — with nothing worse than a
    warning to show for it.

    Only tags that have something in them count. On a sample show most rows
    carry no tag at all, which is a different problem and already warned about
    further down.
  */
  const tagged = records.filter((r) => r["Item Number"] !== "" && r["Custom Label"] !== "");
  if (
    tagged.length > 1 &&
    tagged.every((r) => parseShiftTag(r["Custom Label"]) === null) &&
    tagged.every((r) => looksLikeSpreadsheetDateTime(r["Custom Label"]))
  ) {
    return {
      sales: [],
      dropped: [],
      flags: [
        ...flags,
        {
          severity: "blocking",
          message:
            `${file.name}: every show tag reads like "${tagged[0]["Custom Label"]}" rather than "09.08.26 PM" — ` +
            `a spreadsheet has rewritten the Custom Label column. On eBay that tag is the only thing that says ` +
            `whether a sale belongs to the day show or the night one, so importing this would pay the wrong ` +
            `pair. Nothing was imported. Download the report again, and if it needs editing, open it in Google ` +
            `Sheets (File, Import, and turn off "Convert text to numbers"), or in Excel use Data, From Text/CSV ` +
            `and set every column to Text.`,
        },
      ],
    };
  }

  /* ---------------------------------------------------------- groups (R7) */

  const groups = new Map<string, Record<string, string>[]>();
  for (const record of records) {
    const key = record["Sales Record Number"];
    const existing = groups.get(key);
    if (existing) existing.push(record);
    else groups.set(key, [record]);
  }

  // The footer's count is the number of sales records, not the number of rows.
  // Read from wherever the phrase landed. Saving the file again can merge the
  // count and the words into one cell, and this is the only check that would
  // catch rows lost in that re-save — so it must not go quiet just because the
  // footer changed shape.
  const footerCount = footer
    .map((row) => {
      const line = row.slice(0, 3).join(" ");
      // The count as a spreadsheet may have written it: `1,010 record(s)`.
      const match = /([\d,]+)\s*record\(s\) downloaded/i.exec(line);
      return match ? Number(match[1].replace(/,/g, "")) : NaN;
    })
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
        // Decided by the caller from that day's schedule, because the file has
        // nothing in it that could say. See `placeEbayFile`.
        business,
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

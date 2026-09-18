/**
 * Reading a TikTok Shop export (F2).
 *
 * One file is one show. TikTok exports separately for each, and the file — not
 * the tag on the row — is what decides which show an order belongs to (R1).
 * Every timestamp in the file is Pacific (R2), so the show's own date comes out
 * of the Pacific clock and a night order that has already crossed midnight in
 * Miami still belongs to the day it was sold on.
 *
 * One row is one order is one watch, always (R3).
 */

import { TZDate } from "@date-fns/tz";
import type { DateISO } from "../types";
import { businessOfHandle } from "../business";
import { checkHeaders, parseCsv, toRecords } from "./csv";
import {
  TIKTOK_HEADERS,
  TIKTOK_NIGHT_FROM_HOUR,
  TIKTOK_TIMEZONE,
  defaultShiftTag,
  parseMoney,
  parseShiftTag,
} from "./types";
import type { DroppedRow, ImportFlag, ParseResult, ShowKey, WatchSale } from "./types";

/** `MM/DD/YYYY h:mm:ss AM/PM` — 12-hour, no leading zero on the hour. */
const DATETIME_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Reads one of TikTok's timestamps as the Pacific wall-clock it is.
 *
 * Returned as components rather than an instant on purpose: the show and its
 * date are decided from the wall clock, and converting first would mean
 * converting back.
 */
export function parseTikTokDateTime(raw: string): WallClock | null {
  const match = DATETIME_RE.exec(raw.trim());
  if (!match) return null;

  const [, mo, d, y, h, mi, s, meridiem] = match;
  let hour = Number(h) % 12;
  if (meridiem.toUpperCase() === "PM") hour += 12;

  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return { year: Number(y), month, day, hour, minute: Number(mi), second: Number(s) };
}

/** The real instant a Pacific wall-clock reading refers to. */
export function toInstant(wall: WallClock): Date {
  return new Date(
    new TZDate(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
      0,
      TIKTOK_TIMEZONE,
    ).getTime(),
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateOf = (wall: WallClock): DateISO =>
  `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;

export interface TikTokFile {
  name: string;
  text: string;
}

/**
 * Parses one TikTok file into paid watches, dropped rows and flags.
 *
 * A header that does not match the contract stops the file dead with a blocking
 * flag and no sales, because every rule below depends on reading the right
 * column and a renamed one produces plausible nonsense rather than an error.
 */
export function parseTikTokFile(file: TikTokFile): ParseResult {
  const flags: ImportFlag[] = [];
  const rows = parseCsv(file.text);

  if (rows.length === 0) {
    return { sales: [], dropped: [], flags: [{ severity: "blocking", message: `${file.name} is empty.` }] };
  }

  const header = checkHeaders(rows[0], TIKTOK_HEADERS);
  if (!header.ok) {
    return {
      sales: [],
      dropped: [],
      flags: [
        {
          severity: "blocking",
          message: `${file.name}: the TikTok export has changed shape — ${header.problems[0]}. No figures produced.`,
        },
      ],
    };
  }
  if (header.extra.length > 0) {
    flags.push({
      severity: "warning",
      message: `${file.name}: ${header.extra.length} new column(s) appended (${header.extra.join(", ")}). Ignored.`,
    });
  }

  const records = toRecords(rows[0], rows.slice(1)).filter(
    (r) => (r["Order ID"] ?? "") !== "",
  );
  if (records.length === 0) {
    return { sales: [], dropped: [], flags: [{ severity: "blocking", message: `${file.name} has no rows.` }] };
  }

  /* ------------------------------------------- which show is this file (R1) */

  let earliest: WallClock | null = null;
  let unreadableTimes = 0;
  for (const record of records) {
    const wall = parseTikTokDateTime(record["Created Time"]);
    if (!wall) {
      unreadableTimes++;
      continue;
    }
    if (!earliest || toInstant(wall).getTime() < toInstant(earliest).getTime()) earliest = wall;
  }

  if (!earliest) {
    return {
      sales: [],
      dropped: [],
      flags: [
        {
          severity: "blocking",
          message: `${file.name}: no readable Created Time, so the show cannot be determined.`,
        },
      ],
    };
  }
  if (unreadableTimes > 0) {
    flags.push({
      severity: "warning",
      message: `${file.name}: ${unreadableTimes} row(s) had an unreadable Created Time.`,
    });
  }

  const half: "AM" | "PM" = earliest.hour < TIKTOK_NIGHT_FROM_HOUR ? "AM" : "PM";
  const show: ShowKey = half === "AM" ? "TikTok AM" : "TikTok PM";
  const showDate = dateOf(earliest);

  /* ------------------------------------------- which shop exported it (R16) */

  /*
    The file names its own shop, and that is the only thing that can place it.

    Watches and diamonds sell through separate seller accounts at the same
    hours — on 09/15 diamonds ran 10:32-16:01 Pacific against the watch day
    show's 10:06-16:05 — so the clock tells day from night and never one
    business from the other.

    An unknown shop stops the file dead rather than being guessed at. A report
    placed on the wrong show pays that show's pair commission out of takings
    that were never theirs, and nothing downstream would ever notice. Adding a
    shop is one line in `domain/business`.
  */
  const handles = new Set(
    records.map((r) => (r["Creator Handle"] ?? "").trim()).filter((h) => h !== ""),
  );

  if (handles.size === 0) {
    return {
      sales: [],
      dropped: [],
      flags: [
        {
          severity: "blocking",
          message:
            `${file.name}: no Creator Handle on any row, so there is no way to tell which shop ` +
            `this is. Nothing was loaded.`,
        },
      ],
    };
  }
  if (handles.size > 1) {
    return {
      sales: [],
      dropped: [],
      flags: [
        {
          severity: "blocking",
          message:
            `${file.name}: rows come from ${handles.size} different shops (${[...handles].join(", ")}). ` +
            `One export is one shop. Nothing was loaded.`,
        },
      ],
    };
  }

  const handle = [...handles][0];
  const business = businessOfHandle(handle);
  if (!business) {
    return {
      sales: [],
      dropped: [],
      flags: [
        {
          severity: "blocking",
          message:
            `${file.name} is from the shop "${handle}", which this system does not know. It has ` +
            `not been loaded, and nothing else on the day was affected.`,
        },
      ],
    };
  }

  /* ------------------------------------------------------------ every row */

  const sales: WatchSale[] = [];
  const dropped: DroppedRow[] = [];
  const tagCounts = new Map<string, number>();
  const malformed: string[] = [];
  let blankTags = 0;
  let variationNumbers = 0;

  for (const record of records) {
    const orderRef = record["Order ID"];
    const status = record["Order Status"];
    const amount = parseMoney(record["Order Amount"]);

    // Cancelled means never paid: TikTok books a charge and its reversal, and
    // neither figure is money (R5). Count neither, drop the row (R6).
    if (status === "Canceled") {
      dropped.push({
        sourceFile: file.name,
        platform: "TIKTOK",
        orderRef,
        buyer: record["Buyer Username"],
        stockNumber: record["Product Name"],
        amount,
        reason: `Canceled: ${record["Cancel Reason"] || "no reason given"}`,
      });
      continue;
    }

    // Defensive: never seen on a live order, and never decided from tracking,
    // package or label columns (R10).
    if (record["Paid Time"] === "") {
      dropped.push({
        sourceFile: file.name,
        platform: "TIKTOK",
        orderRef,
        buyer: record["Buyer Username"],
        stockNumber: record["Product Name"],
        amount,
        reason: "no Paid Time",
      });
      continue;
    }

    const rawTag = record["Seller SKU"];
    const parsedTag = parseShiftTag(rawTag);
    if (!parsedTag) {
      if (rawTag.trim() === "") blankTags++;
      // The diamond shop's Seller SKU is the listing's variation number, 1–9,
      // on every row, real pieces included. Not a show tag, so not a bad one.
      else if (business === "DIAMOND" && /^\d{1,3}$/.test(rawTag.trim())) variationNumbers++;
      else malformed.push(`${orderRef} (${record["Product Name"]}, $${amount})`);
    }
    const tag = parsedTag ? rawTag : defaultShiftTag(showDate, half);
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);

    const created = parseTikTokDateTime(record["Created Time"]);
    const paid = parseTikTokDateTime(record["Paid Time"]);

    sales.push({
      business,
      platform: "TIKTOK",
      show,
      showDate,
      shiftTag: tag,
      rawShiftTag: rawTag,
      shiftTagValid: parsedTag !== null,

      orderRef,
      lineRef: record["SKU ID"],
      buyer: record["Buyer Username"],
      stockNumber: record["Product Name"],
      category: record["Product Category"],
      qty: Number(record["Quantity"]) || 1,

      unitPrice: parseMoney(record["SKU Unit Original Price"]),
      platformDiscount: parseMoney(record["SKU Platform Discount"]),
      sellerDiscount: parseMoney(record["SKU Seller Discount"]),
      netItemPrice: parseMoney(record["SKU Subtotal After Discount"]),
      shipping: parseMoney(record["Shipping Fee After Discount"]),
      taxAndFees: parseMoney(record["Taxes"]) + parseMoney(record["Retail Delivery Fee"]),
      orderTotal: amount,

      createdAt: created ? toInstant(created) : null,
      paidOn: paid ? dateOf(paid) : null,

      shipToName: record["Recipient"],
      state: record["State"],
      paymentMethod: record["Payment Method"],

      packageId: record["Package ID"],
      tracking: record["Tracking ID"],
      sourceFile: file.name,
    });
  }

  if (malformed.length > 0) {
    flags.push({
      severity: "warning",
      message:
        `${file.name}: ${malformed.length} row(s) had an unreadable shift tag and were credited to ` +
        `${defaultShiftTag(showDate, half)} (R13) — ${malformed.slice(0, 3).join("; ")}` +
        (malformed.length > 3 ? ` and ${malformed.length - 3} more` : ""),
    });
  }

  /*
    A blank tag is not a junk one.

    TikTok listings stopped carrying the show tag in September 2026: every row of
    the 09/14 exports has an empty Seller SKU. Each was a warning — 474 on one
    morning — which buries the warnings that matter. On TikTok the file decides
    the show and the pay (R1), so an empty tag loses nothing and is noted once. A
    tag that is present and unreadable, like the "1" on 09/08, still warns.
  */
  if (blankTags > 0) {
    flags.push({
      severity: "info",
      message:
        `${file.name}: the show tag (Seller SKU) is blank on ${blankTags} row(s). They are credited to this ` +
        `file's show, ${defaultShiftTag(showDate, half)} — on TikTok the file decides the show and the pay anyway.`,
    });
  }

  /*
    The diamond shop uses Seller SKU for something else.

    Every row of the 09/15 diamond export carries a bare 1–9 there — the
    listing's variation number, real pieces as well as placeholders. Reading
    those as broken show tags put "36 row(s) had an unreadable shift tag" at the
    top of every diamond upload, a warning about nothing that would have been
    there every single time. Noted once instead, like a blank tag, since on
    TikTok the file decides the show and the pay regardless (R1).
  */
  if (variationNumbers > 0) {
    flags.push({
      severity: "info",
      message:
        `${file.name}: on the diamond shop, Seller SKU holds the listing's variation number rather than a ` +
        `show tag (${variationNumbers} row(s)). They are credited to this file's show, ` +
        `${defaultShiftTag(showDate, half)} — on TikTok the file decides the show and the pay anyway.`,
    });
  }

  // The tag is only ever a sanity check on TikTok; a disagreement is reported
  // and never acted on (R1).
  const majority = [...tagCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (majority) {
    const majorityTag = parseShiftTag(majority[0]);
    if (majorityTag && majorityTag.half !== half) {
      flags.push({
        severity: "warning",
        message: `${file.name}: the order times say this is the ${half} show, but most rows are tagged ${majorityTag.half}. The file decides; nothing was changed.`,
      });
    }
  }

  return { sales, dropped, flags };
}

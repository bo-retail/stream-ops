/**
 * The vocabulary of an import, and the two header contracts.
 *
 * Everything in `src/lib/domain/imports` is pure: text in, records out, no
 * database and no file system. That is what lets the whole ingestion be tested
 * against real exports without a running app.
 */

import type { Business } from "../business";
import type { DateISO } from "../types";

export type ImportPlatform = "TIKTOK" | "EBAY";

/**
 * Where a watch sold. Not the same thing as who is paid for it — see
 * `shiftTag`. An item listed for the morning show can sell in the evening one.
 */
export type ShowKey = "TikTok AM" | "TikTok PM" | "eBay AM" | "eBay PM";

/**
 * One paid watch. The unified record every downstream view is built from —
 * the box list now, sales and commission later.
 *
 * Money is carried in full even though shipping does not need it, because this
 * is the only parse of these files that will ever exist and re-reading them
 * later to recover a column we chose not to keep would be the mistake.
 */
export interface WatchSale {
  /**
   * Which kind of show sold it — watches or diamonds.
   *
   * Read from the file itself: a TikTok export names its own shop in `Creator
   * Handle`, and that is the only thing that can tell two same-day TikTok files
   * apart, since both shows run the same hours. eBay names no seller anywhere
   * in its 82 columns, so while only watches sell there an eBay file is a watch
   * file.
   */
  business: Business;
  platform: ImportPlatform;
  show: ShowKey;
  showDate: DateISO;

  /** The tag as it will be paid on, defaulted to the file's shift if malformed. */
  shiftTag: string;
  /** Exactly what the column said, kept whether or not it parsed. */
  rawShiftTag: string;
  shiftTagValid: boolean;

  orderRef: string;
  lineRef: string;
  buyer: string;
  /** The stock number. TikTok `Product Name`, eBay `Item Title`. */
  stockNumber: string;
  category: string;
  qty: number;

  unitPrice: number;
  platformDiscount: number;
  sellerDiscount: number;
  /** After both discounts. The headline revenue figure (R14). */
  netItemPrice: number;
  /** Carried through untouched and uninterpreted (R9). */
  shipping: number;
  taxAndFees: number;
  orderTotal: number;

  createdAt: Date | null;
  paidOn: DateISO | null;

  shipToName: string;
  state: string;
  paymentMethod: string;

  packageId: string;
  tracking: string;
  sourceFile: string;
}

/** A raw row that was not counted, and why. Becomes the Exceptions list. */
export interface DroppedRow {
  sourceFile: string;
  platform: ImportPlatform;
  orderRef: string;
  buyer: string;
  stockNumber: string;
  /** Whatever amount the row printed, for the record only. */
  amount: number;
  reason: string;
}

export type FlagSeverity = "blocking" | "warning" | "info";

export interface ImportFlag {
  severity: FlagSeverity;
  message: string;
}

export interface ParseResult {
  sales: WatchSale[];
  dropped: DroppedRow[];
  flags: ImportFlag[];
}

/** TikTok records its timestamps in California time, always (R2). */
export const TIKTOK_TIMEZONE = "America/Los_Angeles";

/**
 * Before this hour, Pacific, the file is the day show.
 *
 * 16:00 Pacific is 19:00 Eastern — the same Day/Night boundary the schedule
 * already uses. Verified against real exports: day files open 10:17–10:23 PT,
 * night files 16:38–16:53 PT.
 */
export const TIKTOK_NIGHT_FROM_HOUR = 16;

/**
 * Money as the exports write it: `$25.00`, `1,022.25`, or blank.
 *
 * Blank is zero. Anything unparseable is zero rather than NaN, because a NaN
 * propagates silently through a total whereas a zero shows up in the
 * arithmetic check.
 */
export function parseMoney(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return 0;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : 0;
}

export interface ShiftTag {
  dateISO: DateISO;
  half: "AM" | "PM";
  /** A platform token such as `TT`, when the tag carries one. */
  token: string | null;
}

/**
 * Reads a shift tag: `09.08.26 PM`, or `08.29.26 TT AM`.
 *
 * The master spec's R13 allows only `MM.DD.YY AM|PM`. Real files carry both
 * forms — the 09/08 exports use the bare one, the 08/30 export puts `TT`
 * between the date and the half. Under the stricter rule every row of such a
 * file is flagged as malformed, which is noise, not a finding. The optional
 * token is therefore accepted and kept.
 */
const SHIFT_TAG_RE = /^(\d{2})\.(\d{2})\.(\d{2})(?:\s+([A-Za-z]{1,8}))?\s+(AM|PM)$/i;

export function parseShiftTag(raw: string): ShiftTag | null {
  const match = SHIFT_TAG_RE.exec(raw.trim());
  if (!match) return null;

  const [, mm, dd, yy, token, half] = match;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return {
    dateISO: `20${yy}-${mm}-${dd}`,
    half: half.toUpperCase() as "AM" | "PM",
    token: token ? token.toUpperCase() : null,
  };
}

/** The tag a row falls back to when its own is unreadable (R13). */
export function defaultShiftTag(showDate: DateISO, half: "AM" | "PM"): string {
  const [y, m, d] = showDate.split("-");
  return `${m}.${d}.${y.slice(2)} ${half}`;
}

/* ------------------------------------------------------- header contracts */

/**
 * Exactly the 63 TikTok headers, in order, spelling and spacing as exported.
 *
 * The quirks are real and must not be tidied: a leading space in
 * ` Virtual Bundle Seller SKU`, lower-case in `Payment platform discount`,
 * `Sku Quantity of return`, and "Cancelation" in one column against
 * "Cancelled" in another.
 */
export const TIKTOK_HEADERS: readonly string[] = [
  "Order ID",
  "Order Status",
  "Order Substatus",
  "Cancelation/Return Type",
  "Normal or Pre-order",
  "SKU ID",
  "Seller SKU",
  "Product ID",
  "Product Name",
  // Note the order: `Variation` comes before ` Virtual Bundle Seller SKU`.
  // The master spec's A3 table lists these two the other way round; the real
  // exports for 08/30, 09/08 and 09/09 all agree with what is written here.
  "Variation",
  "Virtual Bundle Seller SKU",
  "Quantity",
  "Sku Quantity of return",
  "SKU Unit Original Price",
  "SKU Subtotal Before Discount",
  "SKU Platform Discount",
  "SKU Seller Discount",
  "SKU Subtotal After Discount",
  "Shipping Fee After Discount",
  "Original Shipping Fee",
  "Shipping Fee Seller Discount",
  "Co-Funded Shipping Fee Discount",
  "Shipping Fee Platform Discount",
  "Payment platform discount",
  "Retail Delivery Fee",
  "Taxes",
  "Order Amount",
  "Order Refund Amount",
  "Created Time",
  "Paid Time",
  "RTS Time",
  "Shipped Time",
  "Delivered Time",
  "Cancelled Time",
  "Cancel By",
  "Cancel Reason",
  "Fulfillment Type",
  "Warehouse Name",
  "Tracking ID",
  "Delivery Option Type",
  "Delivery Option",
  "Shipping Provider Name",
  "Buyer Message",
  "Buyer Nickname",
  "Buyer Username",
  "Recipient",
  "Phone #",
  "Country",
  "State",
  "City",
  "Zipcode",
  "Address Line 1",
  "Address Line 2",
  "Delivery Instruction",
  "Payment Method",
  "Weight(kg)",
  "Product Category",
  "Package ID",
  "Seller Note",
  "Shipping Information",
  "Combined Listing",
  "Order Channel",
  "Creator Handle",
];

/** Exactly the 82 eBay headers, in order. */
export const EBAY_HEADERS: readonly string[] = [
  "Sales Record Number",
  "Order Number",
  "Buyer Username",
  "Buyer Name",
  "Buyer Email",
  "Buyer Note",
  "Buyer Address 1",
  "Buyer Address 2",
  "Buyer City",
  "Buyer State",
  "Buyer Zip",
  "Buyer Country",
  "Buyer Tax Identifier Name",
  "Buyer Tax Identifier Value",
  "Ship To Name",
  "Ship To Phone",
  "Ship To Address 1",
  "Ship To Address 2",
  "Ship To City",
  "Ship To State",
  "Ship To Zip",
  "Ship To Country",
  "Item Number",
  "Item Title",
  "Custom Label",
  "Sold Via Promoted Listings",
  "Quantity",
  "Sold For",
  "Shipping And Handling",
  "Item Location",
  "Item Zip Code",
  "Item Country",
  "eBay Collect And Remit Tax Rate",
  "eBay Collect And Remit Tax Type",
  "eBay Reference Name",
  "eBay Reference Value",
  "Tax Status",
  "Seller Collected Tax",
  "eBay Collected Tax",
  "Electronic Waste Recycling Fee",
  "Mattress Recycling Fee",
  "Battery Recycling Fee",
  "White Goods Disposal Tax",
  "Tire Recycling Fee",
  "Additional Fee",
  "Lumber Fee",
  "Prepaid Wireless Fee",
  "Road Improvement And Food Delivery Fee",
  "eBay Collected Charges",
  "Total Price",
  "eBay Collected Tax and Fees Included in Total",
  "Payment Method",
  "Sale Date",
  "Paid On Date",
  "Ship By Date",
  "Minimum Estimated Delivery Date",
  "Maximum Estimated Delivery Date",
  "Shipped On Date",
  "Feedback Left",
  "Feedback Received",
  "My Item Note",
  "PayPal Transaction ID",
  "Shipping Service",
  "Tracking Number",
  "Transaction ID",
  "Variation Details",
  "Global Shipping Program",
  "Global Shipping Reference ID",
  "Click And Collect",
  "Click And Collect Reference Number",
  "eBay Plus",
  "Authenticity Verification Program",
  "Authenticity Verification Status",
  "Authenticity Verification Outcome Reason",
  "PSA Vault Program",
  "Vault Fulfillment Type",
  "eBay Fulfillment Program",
  "Tax City",
  "Tax State",
  "Tax Zip",
  "Tax Country",
  "eBay International Shipping",
];

/** Recognising a file by content, never by its name (F1). */
export function detectPlatform(rows: readonly (readonly string[])[]): ImportPlatform | null {
  const first = rows[0]?.map((c) => c.trim()) ?? [];
  if (first[0] === "Order ID") return "TIKTOK";

  // eBay opens with a row of bare commas; the header is the line after it.
  const second = rows[1]?.map((c) => c.trim()) ?? [];
  if (second[0] === "Sales Record Number") return "EBAY";

  return null;
}

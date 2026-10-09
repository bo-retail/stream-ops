/**
 * Synthetic order exports, for tests and check scripts.
 *
 * Built from the real headers but with made-up orders, so they can be committed:
 * the real exports carry customer names and addresses and never are.
 */
import { EBAY_HEADERS, TIKTOK_HEADERS } from "./types";

/* ------------------------------------------------------------ the files */

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** "2021-03-10" → "Mar-10-21", the way eBay writes a date. */
function ebayDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    Number(m) - 1
  ];
  return `${month}-${d}-${y.slice(2)}`;
}

/** "2021-03-10" → "03.10.21", the show tag's date. */
const tagDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${m}.${d}.${y.slice(2)}`;
};

export interface EbayOrder {
  srn: string;
  /** The show it sold in. */
  showDay: string;
  /** When the buyer paid. */
  paidDay: string;
  /** eBay's Sale Date — the checkout. The show day unless the buyer checked out later. */
  saleDay?: string;
  /** The Custom Label, when it is not the plain show tag ("10.08.26 AM-PM"). */
  label?: string;
  tracking?: string;
  /** Defaults to one buyer per order. A shared label is one buyer. */
  buyer?: string;
  price?: string;
}

/** An eBay order report from the watch account. */
export function ebayReport(orders: EbayOrder[]): string {
  const rows = orders.map((o) => {
    const row: Record<string, string> = {
      "Sales Record Number": o.srn,
      "Order Number": `18-15123-${o.srn.padStart(5, "0")}`,
      "Buyer Username": o.buyer ?? `buyer_${o.srn}`,
      "Ship To Name": o.buyer ?? `Buyer ${o.srn}`,
      "Ship To State": "IL",
      "Item Number": `4071972${o.srn.padStart(5, "0")}`,
      "Item Title": `W${o.srn}`,
      "Custom Label": o.label ?? `${tagDate(o.showDay)} PM`,
      Quantity: "1",
      "Sold For": o.price ?? "$25.00",
      "Total Price": o.price ?? "$25.00",
      "Sale Date": ebayDate(o.saleDay ?? o.showDay),
      "Paid On Date": ebayDate(o.paidDay),
      "Tracking Number": o.tracking ?? `9434608106245552${o.srn.padStart(6, "0")}`,
      "Transaction ID": `12345678${o.srn.padStart(6, "0")}`,
    };
    return EBAY_HEADERS.map((h) => cell(row[h] ?? "")).join(",");
  });
  return (
    "﻿" +
    [
      ",".repeat(41),
      EBAY_HEADERS.map((h) => `"${h}"`).join(","),
      EBAY_HEADERS.map(() => '""').join(","),
      ...rows,
      "",
      `${orders.length},record(s) downloaded,`,
      "Seller ID : vaultshowofficial",
    ].join("\r\n")
  );
}

export interface TiktokOptions {
  /** When the orders were placed: "07:05:00 PM" is the night show. The day show if left out. */
  time?: string;
  /** Each row's product name, which is its stock number. One with a space is a placeholder listing. */
  names?: string[];
  /** A label for every row, or row by row: one buyer's orders sharing a box. */
  tracking?: string | (string | undefined)[];
  /** One buyer on every row, as a shared label must have. */
  buyer?: string;
}

/** A TikTok export from one shop, for one show of one day. */
export function tiktokReport(
  handle: string,
  day: string,
  n: number,
  idBase: string,
  options: TiktokOptions = {},
): string {
  const time = options.time ?? "10:17:29 AM";
  const [y, m, d] = day.split("-");
  const header = TIKTOK_HEADERS.map((h) =>
    h === "Virtual Bundle Seller SKU" ? " Virtual Bundle Seller SKU" : h,
  );
  const lines = [header.join(",")];
  for (let i = 0; i < n; i++) {
    const id = `${idBase}${String(i).padStart(4, "0")}`;
    const row: Record<string, string> = {
      "Order ID": `${id}\t`,
      "Order Status": "To ship",
      "Order Substatus": "Awaiting collection",
      "SKU ID": `17294${id}\t`,
      "Seller SKU": `${tagDate(day)} ${time.endsWith("PM") ? "PM" : "AM"}`,
      "Product ID": `17295${id}\t`,
      "Product Name": options.names?.[i] ?? `T${id.slice(-6)}`,
      Variation: "Default",
      Quantity: "1",
      "SKU Unit Original Price": "41",
      "SKU Subtotal Before Discount": "41",
      "SKU Platform Discount": "0",
      "SKU Seller Discount": "0",
      "SKU Subtotal After Discount": "41",
      "Shipping Fee After Discount": "8.99",
      Taxes: "3.06",
      "Retail Delivery Fee": "0",
      "Order Amount": "53.05",
      "Created Time": `${m}/${d}/${y} ${time}\t`,
      "Paid Time": `${m}/${d}/${y} ${time}\t`,
      "Tracking ID":
        (Array.isArray(options.tracking) ? options.tracking[i] : options.tracking) ?? `92346903${id}`,
      "Buyer Username": options.buyer ?? `buyer.${id}`,
      Recipient: "T**** B****",
      State: "Illinois",
      "Payment Method": "ApplePay",
      "Product Category": "Quartz Watches",
      "Package ID": `11534${id}\t`,
      "Order Channel": "LIVE",
      "Creator Handle": handle,
    };
    lines.push(TIKTOK_HEADERS.map((h) => cell(row[h] ?? "")).join(","));
  }
  return "﻿" + lines.join("\r\n");
}

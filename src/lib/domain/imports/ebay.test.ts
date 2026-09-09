import { describe, expect, it } from "vitest";
import { parseEbayDate, parseEbayFile } from "./ebay";
import { EBAY_HEADERS } from "./types";

/**
 * Builds an eBay export from partial rows, including the decoration.
 *
 * Line 1 is a row of bare commas, line 2 the header, line 3 an all-empty data
 * row, then the table, then a blank line and two footer lines. Synthetic — the
 * real export carries unmasked customer names and addresses and is never
 * committed.
 */
function ebayCsv(rows: Record<string, string>[], recordCount?: number): string {
  const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = [
    ",".repeat(41),
    EBAY_HEADERS.map((h) => `"${h}"`).join(","),
    EBAY_HEADERS.map(() => '""').join(","),
    ...rows.map((row) => EBAY_HEADERS.map((h) => cell(row[h] ?? "")).join(",")),
    "",
    `${recordCount ?? new Set(rows.map((r) => r["Sales Record Number"])).size},record(s) downloaded,`,
    "Seller ID : vaultshowofficial",
  ];
  return "﻿" + lines.join("\r\n");
}

/** A paid single-watch order — the ordinary case, 136 of 143 on a real day. */
function single(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Sales Record Number": "29466",
    "Order Number": "18-15123-90440",
    "Buyer Username": "test_buyer",
    "Buyer Name": "Test Buyer",
    "Ship To Name": "Test Buyer",
    "Ship To State": "SC",
    "Item Number": "407197269275",
    "Item Title": "50967",
    "Custom Label": "09.08.26 PM",
    "Quantity": "1",
    "Sold For": "$25.00",
    "Shipping And Handling": "$3.99",
    "eBay Collected Tax": "$2.00",
    "Total Price": "$30.99",
    "Sale Date": "Sep-08-26",
    "Paid On Date": "Sep-08-26",
    "Tracking Number": "9434608106245552015332",
    "Transaction ID": "12345678901234",
    ...overrides,
  };
}

const parse = (rows: Record<string, string>[], count?: number) =>
  parseEbayFile({ name: "eBay-OrdersReport.csv", text: ebayCsv(rows, count) });

describe("reading eBay dates", () => {
  it("reads the Mon-DD-YY form", () => {
    expect(parseEbayDate("Sep-08-26")).toBe("2026-09-08");
    expect(parseEbayDate("Dec-25-26")).toBe("2026-12-25");
  });

  it("rejects anything else rather than guessing", () => {
    expect(parseEbayDate("")).toBeNull();
    expect(parseEbayDate("2026-09-08")).toBeNull();
    expect(parseEbayDate("Xyz-08-26")).toBeNull();
  });
});

describe("finding the table inside the file", () => {
  it("skips the comma row, the header and the empty placeholder row", () => {
    const result = parse([single()]);
    expect(result.sales).toHaveLength(1);
    expect(result.sales[0].stockNumber).toBe("50967");
  });

  it("stops before the footer rather than reading the record count as an order", () => {
    // `143,record(s) downloaded,` starts with digits and would otherwise parse
    // as a sales record number.
    const result = parse([single()]);
    expect(result.sales.map((s) => s.orderRef)).toEqual(["29466"]);
  });

  it("warns when the footer count disagrees with what was read", () => {
    const result = parse([single()], 99);
    expect(result.flags.some((f) => f.message.includes("footer says 99"))).toBe(true);
  });
});

describe("paid and unpaid", () => {
  it("counts an order with a paid date", () => {
    expect(parse([single()]).sales).toHaveLength(1);
  });

  it("drops a committed-but-never-paid order", () => {
    // eBay keeps these rows with a blank Order Number and no address (R6).
    const result = parse([
      single({ "Sales Record Number": "29463", "Order Number": "", "Paid On Date": "", "Tracking Number": "" }),
    ]);
    expect(result.sales).toHaveLength(0);
    expect(result.dropped[0].reason).toBe("committed but never paid");
  });

  it("treats a whole group as paid when any row in it carries the date", () => {
    // The child rows of a multi-item order are blank in Paid On Date, and are
    // paid nonetheless. Reading the row alone would drop them (R7).
    const result = parse([
      single({ "Sales Record Number": "29462", "Item Number": "", "Item Title": "", "Custom Label": "",
               "Quantity": "2", "Sold For": "$26.00", "Tracking Number": "", "Transaction ID": "" }),
      single({ "Sales Record Number": "29462", "Item Title": "ACW8105MC-005", "Sold For": "$12.00",
               "Paid On Date": "", "Shipping And Handling": "", "eBay Collected Tax": "", "Total Price": "",
               "Ship To Name": "", "Ship To State": "", "Transaction ID": "aaa" }),
      single({ "Sales Record Number": "29462", "Item Title": "ACW8082-018", "Sold For": "$14.00",
               "Paid On Date": "", "Shipping And Handling": "", "eBay Collected Tax": "", "Total Price": "",
               "Ship To Name": "", "Ship To State": "", "Transaction ID": "bbb" }),
    ]);
    expect(result.sales).toHaveLength(2);
    expect(result.sales.every((s) => s.paidOn === "2026-09-08")).toBe(true);
  });
});

describe("a multi-item order", () => {
  const rows = [
    single({ "Sales Record Number": "29462", "Item Number": "", "Item Title": "", "Custom Label": "",
             "Quantity": "2", "Sold For": "$26.00", "Shipping And Handling": "$12.98",
             "eBay Collected Tax": "$1.56", "Total Price": "$40.54",
             "Tracking Number": "", "Transaction ID": "" }),
    single({ "Sales Record Number": "29462", "Item Title": "ACW8105MC-005", "Sold For": "$12.00",
             "Paid On Date": "", "Shipping And Handling": "", "eBay Collected Tax": "", "Total Price": "",
             "Ship To Name": "", "Ship To State": "", "Transaction ID": "aaa" }),
    single({ "Sales Record Number": "29462", "Item Title": "ACW8082-018", "Sold For": "$14.00",
             "Paid On Date": "", "Shipping And Handling": "", "eBay Collected Tax": "", "Total Price": "",
             "Ship To Name": "", "Ship To State": "", "Transaction ID": "bbb" }),
  ];

  it("counts the watches, not the summary", () => {
    // The summary's $26.00 is the sum of its children. Counting it doubles
    // the order (R8).
    const result = parse(rows);
    expect(result.sales.map((s) => s.stockNumber)).toEqual(["ACW8105MC-005", "ACW8082-018"]);
    expect(result.sales.map((s) => s.netItemPrice)).toEqual([12, 14]);
  });

  it("keeps the summary row on the dropped list, with why", () => {
    const result = parse(rows);
    expect(result.dropped[0].reason).toContain("summary row of a 2-item order");
  });

  it("puts the order's shipping, tax and total on the first watch only", () => {
    const result = parse(rows);
    expect(result.sales[0].shipping).toBe(12.98);
    expect(result.sales[0].taxAndFees).toBe(1.56);
    expect(result.sales[0].orderTotal).toBe(40.54);
    expect(result.sales[1].shipping).toBe(0);
    expect(result.sales[1].orderTotal).toBe(0);
  });

  it("takes the ship-to from the summary, since the item rows are blank", () => {
    const result = parse(rows);
    expect(result.sales.every((s) => s.state === "SC")).toBe(true);
    expect(result.sales.every((s) => s.shipToName === "Test Buyer")).toBe(true);
  });
});

describe("which show an eBay row belongs to", () => {
  it("takes the show from the tag, because the file cannot say", () => {
    // One eBay file holds every eBay show of the day and carries no time of
    // day, so the tag decides — the exact reverse of TikTok (R15).
    const result = parse([
      single({ "Custom Label": "09.08.26 PM" }),
      single({ "Sales Record Number": "29467", "Custom Label": "09.08.26 AM", "Transaction ID": "x" }),
    ]);
    expect(result.sales.map((s) => s.show)).toEqual(["eBay PM", "eBay AM"]);
  });

  it("credits an untagged row to PM and flags it loudly", () => {
    const result = parse([single({ "Custom Label": "" })]);
    expect(result.sales[0].show).toBe("eBay PM");
    expect(result.sales[0].shiftTagValid).toBe(false);
    expect(result.flags.some((f) => f.message.includes("fix the listing"))).toBe(true);
  });
});

describe("housekeeping flags", () => {
  it("reports gaps in the sales record sequence without acting on them", () => {
    const result = parse([
      single({ "Sales Record Number": "29460", "Transaction ID": "a" }),
      single({ "Sales Record Number": "29463", "Transaction ID": "b" }),
    ]);
    const gap = result.flags.find((f) => f.message.includes("absent from the sequence"));
    expect(gap?.severity).toBe("info");
    expect(gap?.message).toContain("29461, 29462");
  });

  it("stops the file dead when a column is renamed", () => {
    const text = ebayCsv([single()]).replace('"Item Title"', '"Title"');
    const result = parseEbayFile({ name: "x.csv", text });
    expect(result.sales).toHaveLength(0);
    expect(result.flags[0].severity).toBe("blocking");
  });
});

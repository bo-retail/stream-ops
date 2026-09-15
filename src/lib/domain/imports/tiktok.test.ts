import { describe, expect, it } from "vitest";
import { parseTikTokDateTime, parseTikTokFile, toInstant } from "./tiktok";
import { TIKTOK_HEADERS } from "./types";

/**
 * Builds a TikTok export from partial rows.
 *
 * Synthetic on purpose — the real exports carry unmasked buyer detail on the
 * eBay side and are never committed. The structure here is copied from the real
 * files: BOM, the leading space in one header, trailing tabs on ids and times.
 */
function tiktokCsv(rows: Record<string, string>[]): string {
  const header = TIKTOK_HEADERS.map((h) =>
    h === "Virtual Bundle Seller SKU" ? " Virtual Bundle Seller SKU" : h,
  );
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      TIKTOK_HEADERS.map((h) => {
        const value = row[h] ?? "";
        return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      }).join(","),
    );
  }
  return "﻿" + lines.join("\r\n");
}

/** A paid single-watch order, with the trailing tabs TikTok really writes. */
function paidRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Order ID": "576461234567890123\t",
    "Order Status": "To ship",
    "Order Substatus": "Awaiting collection",
    "SKU ID": "1729412345678901234\t",
    "Seller SKU": "09.08.26 AM",
    "Product ID": "1729512345678901234\t",
    "Product Name": "45874",
    "Variation": "Default",
    "Quantity": "1",
    "SKU Unit Original Price": "41",
    "SKU Subtotal Before Discount": "41",
    "SKU Platform Discount": "0",
    "SKU Seller Discount": "0",
    "SKU Subtotal After Discount": "41",
    "Shipping Fee After Discount": "8.99",
    "Taxes": "3.06",
    "Retail Delivery Fee": "0",
    "Order Amount": "53.05",
    "Created Time": "09/08/2026 10:17:29 AM\t",
    "Paid Time": "09/08/2026 10:17:33 AM\t",
    "Tracking ID": "9234690390470910236904",
    "Buyer Username": "test.buyer",
    "Recipient": "T**** B****",
    "State": "Illinois",
    "Payment Method": "ApplePay",
    "Product Category": "Quartz Watches",
    "Package ID": "1153412345678901234\t",
    "Order Channel": "LIVE",
    ...overrides,
  };
}

const parse = (rows: Record<string, string>[], name = "All order-2026-09-09-07_16.csv") =>
  parseTikTokFile({ name, text: tiktokCsv(rows) });

describe("reading TikTok timestamps", () => {
  it("reads the 12-hour format the export writes", () => {
    expect(parseTikTokDateTime("09/08/2026 4:53:28 PM")).toEqual({
      year: 2026, month: 9, day: 8, hour: 16, minute: 53, second: 28,
    });
  });

  it("reads midnight and noon the right way round", () => {
    expect(parseTikTokDateTime("09/08/2026 12:30:00 AM")?.hour).toBe(0);
    expect(parseTikTokDateTime("09/08/2026 12:30:00 PM")?.hour).toBe(12);
  });

  it("treats the reading as Pacific, not as local or UTC", () => {
    // 10:17 in California is 17:17 UTC in September.
    const instant = toInstant(parseTikTokDateTime("09/08/2026 10:17:00 AM")!);
    expect(instant.toISOString()).toBe("2026-09-08T17:17:00.000Z");
  });

  it("rejects nonsense rather than inventing a date", () => {
    expect(parseTikTokDateTime("")).toBeNull();
    expect(parseTikTokDateTime("2026-09-08 10:17")).toBeNull();
    expect(parseTikTokDateTime("13/45/2026 10:17:00 AM")).toBeNull();
  });
});

describe("deciding which show a file is", () => {
  it("calls it the day show when the first order is before 16:00 Pacific", () => {
    const result = parse([paidRow({ "Created Time": "09/08/2026 10:17:29 AM" })]);
    expect(result.sales[0].show).toBe("TikTok AM");
    expect(result.sales[0].showDate).toBe("2026-09-08");
  });

  it("calls it the night show from 16:00 Pacific", () => {
    const result = parse([
      paidRow({ "Created Time": "09/08/2026 4:53:28 PM", "Seller SKU": "09.08.26 PM" }),
    ]);
    expect(result.sales[0].show).toBe("TikTok PM");
  });

  it("uses the earliest order, not the first row, since rows are newest-first", () => {
    const result = parse([
      paidRow({ "Created Time": "09/08/2026 10:00:00 PM", "Seller SKU": "09.08.26 PM" }),
      paidRow({ "Created Time": "09/08/2026 4:38:00 PM", "Seller SKU": "09.08.26 PM", "Order ID": "2" }),
    ]);
    expect(result.sales[0].show).toBe("TikTok PM");
  });

  it("keeps a night order that has crossed midnight on the show's own date", () => {
    // 22:00 Pacific is 01:00 Eastern the next day. Sales belong to the show
    // date, never to the Eastern calendar date (R2).
    const result = parse([
      paidRow({ "Created Time": "09/08/2026 4:53:00 PM", "Seller SKU": "09.08.26 PM" }),
      paidRow({ "Created Time": "09/08/2026 10:00:43 PM", "Seller SKU": "09.08.26 PM", "Order ID": "2" }),
    ]);
    expect(result.sales.every((s) => s.showDate === "2026-09-08")).toBe(true);
  });
});

describe("which rows count", () => {
  it("drops a cancelled order and counts neither its amount nor its refund", () => {
    // TikTok books a charge and its reversal on an order nobody ever paid (R5).
    const result = parse([
      paidRow({
        "Order ID": "c1",
        "Order Status": "Canceled",
        "Cancel Reason": "Customer overdue to pay",
        "Paid Time": "",
        "Order Amount": "120.07",
        "Order Refund Amount": "119.42",
      }),
    ]);
    expect(result.sales).toHaveLength(0);
    expect(result.dropped[0].reason).toContain("Customer overdue to pay");
    expect(result.dropped[0].amount).toBe(120.07);
  });

  it("drops a row with no Paid Time", () => {
    const result = parse([paidRow({ "Paid Time": "" })]);
    expect(result.sales).toHaveLength(0);
    expect(result.dropped[0].reason).toBe("no Paid Time");
  });

  it("never decides paid from tracking or package columns", () => {
    // An export run before the labels are made has neither, and those orders
    // are still paid (R10).
    const result = parse([paidRow({ "Tracking ID": "", "Package ID": "", "RTS Time": "" })]);
    expect(result.sales).toHaveLength(1);
  });
});

describe("reading a row", () => {
  it("strips the trailing tabs from ids and times", () => {
    const sale = parse([paidRow()]).sales[0];
    expect(sale.orderRef).toBe("576461234567890123");
    expect(sale.packageId).toBe("1153412345678901234");
  });

  it("takes the stock number from Product Name, not from Seller SKU", () => {
    // Seller SKU is the show tag. Getting this backwards puts the commission
    // tag on the packing screen and a date on the sales report.
    const sale = parse([paidRow()]).sales[0];
    expect(sale.stockNumber).toBe("45874");
    expect(sale.rawShiftTag).toBe("09.08.26 AM");
  });

  it("uses the price after both discounts as the net figure", () => {
    const sale = parse([
      paidRow({
        "SKU Unit Original Price": "50",
        "SKU Platform Discount": "5",
        "SKU Seller Discount": "8",
        "SKU Subtotal After Discount": "37",
      }),
    ]).sales[0];
    expect(sale.netItemPrice).toBe(37);
    expect(sale.platformDiscount).toBe(5);
    expect(sale.sellerDiscount).toBe(8);
  });

  it("adds the retail delivery fee into tax", () => {
    const sale = parse([paidRow({ "Taxes": "3.06", "Retail Delivery Fee": "0.50" })]).sales[0];
    expect(sale.taxAndFees).toBeCloseTo(3.56, 2);
  });
});

describe("the shift tag", () => {
  it("keeps a valid tag as it was written", () => {
    const sale = parse([paidRow({ "Seller SKU": "09.08.26 AM" })]).sales[0];
    expect(sale.shiftTag).toBe("09.08.26 AM");
    expect(sale.shiftTagValid).toBe(true);
  });

  it("accepts the form carrying a platform token", () => {
    const sale = parse([paidRow({ "Seller SKU": "09.08.26 TT AM" })]).sales[0];
    expect(sale.shiftTagValid).toBe(true);
  });

  it("falls back to the file's shift when the tag is junk, and flags it", () => {
    const result = parse([paidRow({ "Seller SKU": "1", "SKU Subtotal After Discount": "892" })]);
    expect(result.sales[0].shiftTag).toBe("09.08.26 AM");
    expect(result.sales[0].shiftTagValid).toBe(false);
    expect(result.sales[0].rawShiftTag).toBe("1");
    expect(result.flags.some((f) => f.message.includes("unreadable shift tag"))).toBe(true);
  });

  it("notes a blank tag once, as information, rather than warning on every row", () => {
    // Every row of the 09/14 exports has an empty Seller SKU.
    const result = parse([
      paidRow({ "Seller SKU": "" }),
      paidRow({ "Seller SKU": "", "Order ID": "2" }),
    ]);
    expect(result.sales.every((s) => s.shiftTag === "09.08.26 AM" && !s.shiftTagValid)).toBe(true);
    expect(result.flags.some((f) => f.message.includes("unreadable shift tag"))).toBe(false);
    const notes = result.flags.filter((f) => f.message.includes("blank on 2 row(s)"));
    expect(notes).toHaveLength(1);
    expect(notes[0].severity).toBe("info");
  });

  it("still warns about a junk tag when others on the file are blank", () => {
    const result = parse([
      paidRow({ "Seller SKU": "" }),
      paidRow({ "Seller SKU": "1", "Order ID": "2" }),
    ]);
    expect(
      result.flags.some((f) => f.severity === "warning" && f.message.includes("1 row(s) had an unreadable shift tag")),
    ).toBe(true);
    expect(result.flags.some((f) => f.severity === "info" && f.message.includes("blank on 1 row(s)"))).toBe(true);
  });

  it("warns but does not act when most tags disagree with the file's window", () => {
    // An item listed in the morning can sell at night. The file decides the
    // show; the tag is only a sanity check (R1).
    const result = parse([
      paidRow({ "Created Time": "09/08/2026 4:53:00 PM", "Seller SKU": "09.08.26 AM" }),
      paidRow({ "Created Time": "09/08/2026 5:00:00 PM", "Seller SKU": "09.08.26 AM", "Order ID": "2" }),
    ]);
    expect(result.sales.every((s) => s.show === "TikTok PM")).toBe(true);
    expect(result.flags.some((f) => f.message.includes("most rows are tagged"))).toBe(true);
  });
});

describe("the header contract", () => {
  it("stops the file dead when a column is renamed, and produces no figures", () => {
    const text = tiktokCsv([paidRow()]).replace("Product Name", "Item Name");
    const result = parseTikTokFile({ name: "x.csv", text });
    expect(result.sales).toHaveLength(0);
    expect(result.flags[0].severity).toBe("blocking");
    expect(result.flags[0].message).toContain("changed shape");
  });

  it("tolerates a new column appended at the end", () => {
    const text = tiktokCsv([paidRow()]).replace("Creator Handle", "Creator Handle,Something New");
    const result = parseTikTokFile({ name: "x.csv", text });
    expect(result.sales).toHaveLength(1);
    expect(result.flags.some((f) => f.message.includes("Something New"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { parseEbayDate, parseEbayFile } from "./ebay";
import { EBAY_HEADERS, detectPlatform } from "./types";

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

/**
 * A report that has been opened, edited and saved again.
 *
 * Sample shows are listed under one stand-in listing — "Invicta Random Pulls PM
 * Show" — and the stock numbers are typed into the file afterwards, so this is
 * a file the app is meant to accept. Saving it changes two things that have
 * nothing to do with the edit: the row of bare commas above the header is gone,
 * and every short row is padded out to the full width.
 */
function resaved(text: string): string {
  const lines = text.replace(/^﻿/, "").split("\r\n");
  const width = lines[1].split(",").length;
  return (
    "﻿" +
    lines
      .slice(1)
      .map((line) => {
        const short = width - line.split(",").length;
        return short > 0 ? line + ",".repeat(short) : line;
      })
      .join("\r\n")
  );
}

describe("a report edited outside the app", () => {
  it("reads one whose header is now the first line", () => {
    const text = resaved(ebayCsv([single(), single({ "Sales Record Number": "29467", "Transaction ID": "b" })]));
    const result = parseEbayFile({ name: "edited.csv", text });
    expect(result.sales).toHaveLength(2);
    expect(result.flags.some((f) => f.severity === "blocking")).toBe(false);
  });

  it("does not read the padded footer as an order", () => {
    const text = resaved(ebayCsv([single()]));
    const result = parseEbayFile({ name: "edited.csv", text });
    expect(result.sales).toHaveLength(1);
    expect(result.sales.map((s) => s.orderRef)).toEqual(["29466"]);
  });

  it("refuses one whose long numbers a spreadsheet rounded off", () => {
    const text = ebayCsv([single({ "Tracking Number": "9.43461E+21" })]);
    const result = parseEbayFile({ name: "edited.csv", text });
    expect(result.sales).toHaveLength(0);
    expect(result.flags[0].severity).toBe("blocking");
    expect(result.flags[0].message).toContain("Tracking Number");
    expect(result.flags[0].message).toContain("9.43461E+21");
  });

  it("keeps reading a stock number that only looks like one", () => {
    // 5E+3 is not what a rounded-off number looks like, and a stock number is
    // never refused for its shape.
    const result = parse([single({ "Item Title": "5E3" })]);
    expect(result.sales[0].stockNumber).toBe("5E3");
  });
});

describe("recognising an edited report before anything reads it", () => {
  /*
    `detectPlatform` runs first, in `readFiles`. It used to assume the header
    was the second line too, so an edited report was turned away as "neither a
    TikTok nor an eBay export" — one layer above the reader that had just been
    taught to handle it.
  */
  it("knows a re-saved eBay file is an eBay file", () => {
    const rows = parseCsv(resaved(ebayCsv([single()])));
    expect(detectPlatform(rows)).toBe("EBAY");
  });

  it("still knows an untouched one", () => {
    expect(detectPlatform(parseCsv(ebayCsv([single()])))).toBe("EBAY");
  });

  it("refuses a file whose dates a spreadsheet rewrote", () => {
    const result = parse([single({ "Sale Date": "9/8/2026", "Paid On Date": "9/8/2026" })]);
    expect(result.sales).toHaveLength(0);
    expect(result.flags[0].severity).toBe("blocking");
    expect(result.flags[0].message).toContain("Sep-08-26");
  });

  it("does not mistake a listing title for a rounded-off number", () => {
    // Only the columns holding long numbers are checked, so a stock number of
    // this shape is somebody's listing, not damage.
    const result = parse([single({ "Item Title": "5E+3" })]);
    expect(result.sales).toHaveLength(1);
    expect(result.sales[0].stockNumber).toBe("5E+3");
  });

  it("catches the zero-padded form when the whole column went together", () => {
    // What a converted column looks like: every long value padded, never one.
    const result = parse([
      single({ "Tracking Number": "9434608106245500000000" }),
      single({
        "Sales Record Number": "29467",
        "Transaction ID": "b",
        "Tracking Number": "9434608106245600000000",
      }),
    ]);
    expect(result.sales).toHaveLength(0);
    expect(result.flags[0].message).toContain("Tracking Number");
  });

  it("leaves a padded-looking number alone when its column disagrees", () => {
    /*
      One value with zeros past the fifteenth digit, one without. A spreadsheet
      converts a whole column at once, so a column that disagrees with itself
      was never converted — this is an id that happens to end in zeros, which
      roughly one TikTok order in a thousand does. Refusing on that alone turned
      away 23% of untouched days in testing, each unimportable however many
      times the report was downloaded again.
    */
    const result = parse([
      single({ "Tracking Number": "9434608106245500000000" }),
      single({
        "Sales Record Number": "29467",
        "Transaction ID": "b",
        "Tracking Number": "9434608106245591652376",
      }),
    ]);
    expect(result.sales).toHaveLength(2);
    expect(result.flags.some((f) => f.severity === "blocking")).toBe(false);
  });

  it("leaves one repeated number alone, however it ends", () => {
    // The same value twice is not a column agreeing with itself. A sample show
    // sells under one listing, so its ids repeat on every row.
    const result = parse([
      single({ "Tracking Number": "9434608106245500000000" }),
      single({
        "Sales Record Number": "29467",
        "Transaction ID": "b",
        "Tracking Number": "9434608106245500000000",
      }),
    ]);
    expect(result.sales).toHaveLength(2);
    expect(result.flags.some((f) => f.severity === "blocking")).toBe(false);
  });

  it("refuses a file whose show tags a spreadsheet turned into date-times", () => {
    // The tag is the only thing separating the eBay day show from the night one.
    const result = parse([
      single({ "Custom Label": "9/8/2026 12:00:00 PM" }),
      single({
        "Sales Record Number": "29467",
        "Transaction ID": "b",
        "Custom Label": "9/8/2026 12:00:00 PM",
      }),
    ]);
    expect(result.sales).toHaveLength(0);
    expect(result.flags[0].message).toContain("day show");
  });

  it("but not tags a person mistyped", () => {
    /*
      A tag is typed once into a listing template and copied across the show, so
      one typo makes every tag on a small day unreadable — which looks identical
      to a converted column until you look at the shape. Refusing this would be
      a dead end: the report downloads again saying the same thing, because it
      is what the listing says. It stays the warning it always was.
    */
    const result = parse([
      single({ "Custom Label": "9.8.26 PM" }),
      single({ "Sales Record Number": "29467", "Transaction ID": "b", "Custom Label": "9.8.26 PM" }),
    ]);
    expect(result.sales).toHaveLength(2);
    expect(result.flags.some((f) => f.severity === "blocking")).toBe(false);
    expect(result.flags.some((f) => f.message.includes("fix the listing"))).toBe(true);
  });

  it("but not a sample show, where most rows carry no tag at all", () => {
    // 300 of 314 rows on the real 09/18 report had an empty Custom Label.
    const result = parse([
      single({ "Custom Label": "" }),
      single({ "Sales Record Number": "29467", "Transaction ID": "b", "Custom Label": "" }),
      single({ "Sales Record Number": "29468", "Transaction ID": "c" }),
    ]);
    expect(result.sales).toHaveLength(3);
    expect(result.flags.some((f) => f.severity === "blocking")).toBe(false);
  });
});

describe("damage that matters against damage that does not", () => {
  /*
    09/24: a sample show's stock numbers had been typed in by hand, every
    tracking number survived, and the upload was refused over Item Number and
    Transaction ID — two columns nothing reads. A day of work turned away for
    tidiness.
  */
  it("reads a file whose Item Number and Transaction ID were rounded", () => {
    const result = parse([
      single({ "Item Number": "4.07197E+11", "Transaction ID": "1.23457E+13" }),
      single({ "Sales Record Number": "29467", "Item Number": "4.07198E+11", "Transaction ID": "1.23458E+13" }),
    ]);
    expect(result.sales).toHaveLength(2);
    expect(result.flags.some((f) => f.severity === "blocking")).toBe(false);
    const said = result.flags.find((f) => f.message.includes("Nothing in the app depends on those columns"));
    expect(said?.severity).toBe("warning");
    expect(said?.message).toContain("Item Number");
    expect(said?.message).toContain("Transaction ID");
  });

  it("still knows a summary row from an item row when Item Number is rounded", () => {
    // The only thing Item Number decides is whether the cell is empty.
    const result = parse([
      single({ "Sales Record Number": "29470", "Item Number": "", "Sold For": "$50.00", "Transaction ID": "" }),
      single({ "Sales Record Number": "29470", "Item Number": "4.07197E+11", "Sold For": "$25.00", "Transaction ID": "a" }),
      single({ "Sales Record Number": "29470", "Item Number": "4.07198E+11", "Sold For": "$25.00", "Transaction ID": "b" }),
    ]);
    expect(result.sales).toHaveLength(2);
    expect(result.dropped.some((d) => d.reason.includes("summary row"))).toBe(true);
  });

  it("still refuses one whose tracking numbers were rounded", () => {
    const result = parse([single({ "Tracking Number": "9.43461E+21" })]);
    expect(result.sales).toHaveLength(0);
    expect(result.flags[0].severity).toBe("blocking");
  });
});

describe("what the noted-rounding warning says", () => {
  it("does not claim the day was imported when the file was refused", () => {
    /*
      One Excel save rounds Item Number and rewrites the dates, so both fire at
      once. The refusal and the note arrive together, and the note must not tell
      her the day landed when nothing did.
    */
    const result = parse([
      single({ "Item Number": "4.07197E+11", "Sale Date": "9/8/2026", "Paid On Date": "9/8/2026" }),
    ]);
    expect(result.sales).toHaveLength(0);
    expect(result.flags.some((f) => f.severity === "blocking")).toBe(true);
    for (const flag of result.flags) {
      expect(flag.message).not.toContain("imported in full");
    }
  });

  it("says nothing at all about a file nobody opened", () => {
    const result = parse([single(), single({ "Sales Record Number": "29467", "Transaction ID": "b" })]);
    expect(result.flags.some((f) => f.message.includes("rounded off"))).toBe(false);
  });

  it("notices when two item numbers were rounded to the same value", () => {
    // The realistic collapse: neighbouring listings round to one string.
    const result = parse([
      single({ "Item Number": "4.07197E+11" }),
      single({ "Sales Record Number": "29467", "Transaction ID": "b", "Item Number": "4.07197E+11" }),
    ]);
    expect(result.sales).toHaveLength(2);
    const said = result.flags.find((f) => f.message.includes("Item Number"));
    expect(said?.severity).toBe("warning");
    expect(said?.message).toContain("4.07197E+11");
  });
});

import { describe, expect, it } from "vitest";
import { checkHeaders, isBlankRow, parseCsv, toRecords } from "./csv";

describe("parsing CSV", () => {
  it("strips the byte-order mark both exports carry", () => {
    const rows = parseCsv("﻿Order ID,Order Status\n123,To ship");
    // Left in place this reads as "﻿Order ID" and every lookup by name misses.
    expect(rows[0][0]).toBe("Order ID");
  });

  it("keeps a quoted field containing commas together", () => {
    const rows = parseCsv('a,"one, two",c');
    expect(rows[0]).toEqual(["a", "one, two", "c"]);
  });

  it("keeps a quoted field containing newlines on one row", () => {
    // This is TikTok's Shipping Information column. A line-splitting reader
    // turns one 156-record file into 781 rows of garbage.
    const rows = parseCsv('a,"line one\nline two\nline three",c\nd,e,f');
    expect(rows).toHaveLength(2);
    expect(rows[0][1]).toBe("line one\nline two\nline three");
    expect(rows[1]).toEqual(["d", "e", "f"]);
  });

  it("reads a doubled quote as one literal quote", () => {
    const rows = parseCsv('a,"say ""hello""",c');
    expect(rows[0][1]).toBe('say "hello"');
  });

  it("handles CRLF without producing empty rows", () => {
    const rows = parseCsv("a,b\r\nc,d\r\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps a genuinely blank line, because eBay puts one before its footer", () => {
    const rows = parseCsv("a,b\n\nfooter");
    expect(rows).toHaveLength(3);
    expect(isBlankRow(rows[1])).toBe(true);
    expect(rows[1]).toHaveLength(1);
  });

  it("distinguishes a blank line from an all-empty data row by width", () => {
    // eBay's line 3 is 82 empty quoted fields; the line before its footer is
    // genuinely empty. Treating them alike stops the parser at line 3.
    const rows = parseCsv('"","",""\n\n');
    expect(rows[0]).toHaveLength(3);
    expect(isBlankRow(rows[0])).toBe(true);
    expect(rows[1]).toHaveLength(1);
  });
});

describe("turning rows into records", () => {
  it("trims values, which is what removes TikTok's trailing tabs", () => {
    const rows = parseCsv("Order ID,Zipcode\n576461\t,60614\t");
    const records = toRecords(rows[0], rows.slice(1));
    expect(records[0]["Order ID"]).toBe("576461");
    expect(records[0]["Zipcode"]).toBe("60614");
  });

  it("trims header names, which fixes the leading space TikTok ships", () => {
    const rows = parseCsv(" Virtual Bundle Seller SKU,Quantity\n,1");
    const records = toRecords(rows[0], rows.slice(1));
    expect(records[0]).toHaveProperty("Virtual Bundle Seller SKU");
  });

  it("gives an empty string for a short row rather than undefined", () => {
    const rows = parseCsv("a,b,c\n1");
    const records = toRecords(rows[0], rows.slice(1));
    expect(records[0].c).toBe("");
  });
});

describe("checking headers against the contract", () => {
  const expected = ["Order ID", "Order Status", "Seller SKU"];

  it("passes when they match exactly", () => {
    expect(checkHeaders(["Order ID", "Order Status", "Seller SKU"], expected).ok).toBe(true);
  });

  it("fails on a renamed column and says which", () => {
    const result = checkHeaders(["Order ID", "Status", "Seller SKU"], expected);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("column 2");
    expect(result.problems[0]).toContain("Order Status");
  });

  it("fails on a reordered column", () => {
    // Reordering is the dangerous one: every value still parses, into the
    // wrong field, and nothing downstream looks broken.
    expect(checkHeaders(["Order Status", "Order ID", "Seller SKU"], expected).ok).toBe(false);
  });

  it("tolerates new columns appended at the end", () => {
    const result = checkHeaders([...expected, "Something New"], expected);
    expect(result.ok).toBe(true);
    expect(result.extra).toEqual(["Something New"]);
  });

  it("fails when the file ends early", () => {
    expect(checkHeaders(["Order ID"], expected).ok).toBe(false);
  });
});

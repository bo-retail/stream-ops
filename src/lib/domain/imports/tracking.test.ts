import { describe, expect, it } from "vitest";
import {
  findSuffixCollisions,
  matchTracking,
  normaliseScan,
  normaliseStockNumber,
} from "./tracking";
import { defaultShiftTag, parseMoney, parseShiftTag } from "./types";

/** A real tracking number from the 09/08 TikTok export. */
const TRACKING = "9234690390470910236904";
/** A real eBay one — note the different prefix. */
const EBAY_TRACKING = "9434608106245552015332";

describe("matching a scanned label", () => {
  const known = [TRACKING, EBAY_TRACKING];

  it("resolves a full IMpb scan with a 5-digit ZIP prefix", () => {
    // 420 + 13057 + the 22-digit tracking. This is what the scanner actually
    // returns; an exact comparison would fail on every single box.
    const scan = "420" + "13057" + TRACKING;
    expect(matchTracking(scan, known)).toEqual({ status: "matched", tracking: TRACKING });
  });

  it("resolves a scan with a 9-digit ZIP+4 prefix", () => {
    const scan = "420" + "130579085" + TRACKING;
    expect(matchTracking(scan, known)).toEqual({ status: "matched", tracking: TRACKING });
  });

  it("resolves a bare tracking number scanned on its own", () => {
    expect(matchTracking(TRACKING, known)).toEqual({ status: "matched", tracking: TRACKING });
  });

  it("ignores spaces and dashes a scanner may insert", () => {
    expect(matchTracking(" 9234 6903 9047 0910 2369 04 ", known)).toEqual({
      status: "matched",
      tracking: TRACKING,
    });
  });

  it("reports a label that is not in the system rather than guessing", () => {
    expect(matchTracking("42013057" + "9999999999999999999999", known)).toEqual({
      status: "unknown",
    });
  });

  it("treats an empty scan as unknown", () => {
    expect(matchTracking("", known)).toEqual({ status: "unknown" });
  });

  it("prefers an exact hit over a suffix hit", () => {
    // "22222" is a suffix of "11122222", so both could match. The scan is
    // exactly one of them, and that settles it.
    expect(matchTracking("11122222", ["22222", "11122222"])).toEqual({
      status: "matched",
      tracking: "11122222",
    });
  });

  it("refuses rather than picks when two tracking numbers could both match", () => {
    // Cannot happen while every tracking number is 22 digits, but if the format
    // ever changes, opening somebody else's box is the wrong way to fail.
    const result = matchTracking("1119922222", ["22222", "9922222"]);
    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" && result.candidates).toHaveLength(2);
  });
});

describe("the suffix-collision guard", () => {
  it("finds nothing when every number is the same length", () => {
    // This is why suffix matching is safe: two distinct strings of equal
    // length cannot be suffixes of one another.
    expect(findSuffixCollisions([TRACKING, EBAY_TRACKING])).toEqual([]);
  });

  it("finds a collision when one number ends with another", () => {
    expect(findSuffixCollisions(["123456", "3456"])).toEqual([["123456", "3456"]]);
  });
});

describe("normalising", () => {
  it("keeps only digits from a scan", () => {
    expect(normaliseScan("420-13057 9200")).toBe("420130579200");
  });

  it("folds case on a stock number but keeps its hyphens", () => {
    expect(normaliseStockNumber(" acw8105mc-001 ")).toBe("ACW8105MC-001");
    expect(normaliseStockNumber("9403obxl")).toBe("9403OBXL");
  });
});

describe("reading a shift tag", () => {
  it("reads the plain form", () => {
    expect(parseShiftTag("09.08.26 PM")).toEqual({
      dateISO: "2026-09-08",
      half: "PM",
      token: null,
    });
  });

  it("reads the form carrying a platform token", () => {
    // Real tags from the 08/30 export. The master spec's R13 pattern rejects
    // these, which would flag every row of that file as malformed.
    expect(parseShiftTag("08.29.26 TT AM")).toEqual({
      dateISO: "2026-08-29",
      half: "AM",
      token: "TT",
    });
  });

  it("rejects the junk value seen on a real listing", () => {
    // A $892 watch on 09/08 was tagged "1". It falls back to the file's shift.
    expect(parseShiftTag("1")).toBeNull();
    expect(parseShiftTag("")).toBeNull();
    expect(parseShiftTag("09.08.26")).toBeNull();
    expect(parseShiftTag("13.99.26 AM")).toBeNull();
  });

  it("builds the fallback tag a bad row is credited to", () => {
    expect(defaultShiftTag("2026-09-08", "AM")).toBe("09.08.26 AM");
  });
});

describe("reading money as the exports write it", () => {
  it("handles the one value with a thousands separator", () => {
    // `1,022.25` is the single order over $1,000 in the 09/07 files. Naive
    // parsing turns it into 1.
    expect(parseMoney("1,022.25")).toBe(1022.25);
  });

  it("handles eBay's dollar signs", () => {
    expect(parseMoney("$25.00")).toBe(25);
  });

  it("treats blank as zero", () => {
    expect(parseMoney("")).toBe(0);
  });

  it("returns zero rather than NaN on nonsense, so a total stays checkable", () => {
    expect(parseMoney("not a number")).toBe(0);
  });
});

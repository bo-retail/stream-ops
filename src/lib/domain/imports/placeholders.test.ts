import { describe, expect, it } from "vitest";
import {
  decidePlaceholderScan,
  isPlaceholderStock,
  listingOfNote,
  looksLikeStockTag,
  placeholderNote,
} from "./placeholders";

const LGD = "LGD - AS SEEN ON SCREEN - NO RETURNS OR CANCELLATIONS";

describe("isPlaceholderStock", () => {
  it("recognises the listing title from the 09/15 diamond export", () => {
    expect(isPlaceholderStock("LGD - As seen on screen - No returns or cancellations")).toBe(true);
    expect(isPlaceholderStock(LGD)).toBe(true);
  });

  it("does not depend on the wording, which changes from show to show", () => {
    expect(isPlaceholderStock("LGA #1")).toBe(true);
    expect(isPlaceholderStock("lga #2")).toBe(true);
  });

  // Every shape of real stock number in the 09/14 and 09/15 exports.
  it.each(["E11397", "E60479", "D42617", "KJE7828-RD-4.00/6", "MPW-0396", "ACW8050MC-012", "48395"])(
    "leaves a real stock number alone: %s",
    (stock) => {
      expect(isPlaceholderStock(stock)).toBe(false);
    },
  );

  it("is not fooled by padding around a real stock number", () => {
    expect(isPlaceholderStock("  E11397  ")).toBe(false);
  });

  it("does not treat a name starting LGD as a placeholder unless it is a sentence", () => {
    expect(isPlaceholderStock("LGD-1042")).toBe(false);
  });
});

describe("looksLikeStockTag", () => {
  it.each(["E11397", "KJE7828-RD-4.00/6", "MPW-0396", "48395"])("accepts %s", (tag) => {
    expect(looksLikeStockTag(tag)).toBe(true);
  });

  // Real misreads from the 09/10–11 packing floor.
  it.each(["WYZ.", "", "  ", "E1"])("refuses %j", (scan) => {
    expect(looksLikeStockTag(scan)).toBe(false);
  });

  it("refuses the placeholder's own title typed back in", () => {
    expect(looksLikeStockTag(LGD)).toBe(false);
  });
});

describe("the scan-log note", () => {
  it("round-trips the listing it was sold as", () => {
    expect(listingOfNote(placeholderNote(LGD))).toBe(LGD);
  });

  it("ignores notes written for anything else", () => {
    expect(listingOfNote("Not in this box")).toBeNull();
    expect(listingOfNote(null)).toBeNull();
  });
});

describe("decidePlaceholderScan", () => {
  const box = (scanned = 0, expected = 1) => [{ stockNumber: LGD, expected, scanned }];
  const clear = { filledHere: [], onAnotherOrder: null, packedElsewhere: null };

  it("records the real tag against the placeholder", () => {
    expect(decidePlaceholderScan({ scanned: "E11397", lines: box(), ...clear })).toEqual({
      kind: "fill",
      listing: LGD,
    });
  });

  it("has nothing to say about a box with no placeholder in it", () => {
    const lines = [{ stockNumber: "E11397", expected: 1, scanned: 0 }];
    expect(decidePlaceholderScan({ scanned: "D42617", lines, ...clear })).toEqual({ kind: "none" });
  });

  it("has nothing to say once the placeholder is already filled", () => {
    expect(decidePlaceholderScan({ scanned: "D42617", lines: box(1, 1), ...clear })).toEqual({
      kind: "none",
    });
  });

  it("refuses a misread rather than recording it as the piece", () => {
    expect(decidePlaceholderScan({ scanned: "WYZ.", lines: box(), ...clear })).toEqual({
      kind: "refuse",
      reason: "notATag",
    });
  });

  it("refuses the same piece twice in one box", () => {
    expect(
      decidePlaceholderScan({ scanned: "E11397", lines: box(1, 2), ...clear, filledHere: ["E11397"] }),
    ).toEqual({ kind: "refuse", reason: "alreadyInThisBox" });
  });

  it("takes a second, different piece when the buyer bought two placeholders", () => {
    expect(
      decidePlaceholderScan({ scanned: "D42617", lines: box(1, 2), ...clear, filledHere: ["E11397"] }),
    ).toEqual({ kind: "fill", listing: LGD });
  });

  /*
    The check that matters on diamonds. The placeholder would take anything, so
    without this the wrong customer's piece goes in the box and closes complete.
  */
  it("refuses a piece that the day's report lists on somebody else's order", () => {
    expect(
      decidePlaceholderScan({ scanned: "E11397", lines: box(), ...clear, onAnotherOrder: "GFUS01073138678849" }),
    ).toEqual({ kind: "refuse", reason: "onAnotherOrder", otherBox: "GFUS01073138678849" });
  });

  it("refuses a piece already packed as another customer's placeholder piece", () => {
    expect(
      decidePlaceholderScan({ scanned: "E11397", lines: box(), ...clear, packedElsewhere: "GFUS01073138679297" }),
    ).toEqual({ kind: "refuse", reason: "packedElsewhere", otherBox: "GFUS01073138679297" });
  });
});

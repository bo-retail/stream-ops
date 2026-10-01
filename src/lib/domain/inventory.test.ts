import { describe, expect, it } from "vitest";
import {
  badModelNumber,
  countLines,
  detailsFromMasterRow,
  masterChanges,
  normaliseModel,
  parseMoney,
  parseQty,
} from "./inventory";

describe("a model number", () => {
  it("is trimmed and upper-cased, nothing else", () => {
    expect(normaliseModel(" tm-525003 ")).toBe("TM-525003");
    expect(normaliseModel("ACW8082-014")).toBe("ACW8082-014");
  });
  it("comes out right when Excel stored it as a number", () => {
    expect(normaliseModel(49888)).toBe("49888");
  });
  it("is empty for nothing", () => {
    expect(normaliseModel(null)).toBe("");
  });
});

describe("a counted quantity", () => {
  it("blank means not counted", () => {
    expect(parseQty("")).toEqual({ kind: "blank" });
    expect(parseQty("  ")).toEqual({ kind: "blank" });
    expect(parseQty(null)).toEqual({ kind: "blank" });
  });
  it("zero means counted, none", () => {
    expect(parseQty("0")).toEqual({ kind: "ok", qty: 0 });
    expect(parseQty(0)).toEqual({ kind: "ok", qty: 0 });
  });
  it("reads whole numbers, typed or from a cell", () => {
    expect(parseQty("12")).toEqual({ kind: "ok", qty: 12 });
    expect(parseQty(12)).toEqual({ kind: "ok", qty: 12 });
    expect(parseQty("12.0")).toEqual({ kind: "ok", qty: 12 });
    expect(parseQty("1,200")).toEqual({ kind: "ok", qty: 1200 });
  });
  it("refuses what is not a whole number of watches", () => {
    for (const bad of ["-1", "1.5", "twelve", "12a", "1e3"]) expect(parseQty(bad).kind).toBe("bad");
    expect(parseQty(-2).kind).toBe("bad");
    expect(parseQty(2.5).kind).toBe("bad");
  });
});

describe("money", () => {
  it("reads dollars to cents", () => {
    expect(parseMoney("58")).toBe(5800);
    expect(parseMoney("$1,058.50")).toBe(105850);
    expect(parseMoney(27.37)).toBe(2737);
  });
  it("is null when empty or not money", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("n/a")).toBeNull();
    expect(parseMoney(-3)).toBeNull();
  });
});

describe("a master-file row", () => {
  const row = {
    "Invicta Model": 49888,
    Brand: "Invicta",
    Collection: "Speedway",
    Gender: "Men",
    Description: "Invicta Speedway Men 51mm",
    URL: "https://cdn.example/49888.jpg",
    "Package weight(lb)": 1,
    "Package length(inch)": 6,
    "Package width(inch)": 6,
    "Package height(inch)": 6,
    "eBay Shipping Profile Name": "eBay Live Shipping Policy Small",
    Cost: 35,
    TP: 53.846,
  };
  it("is read by its headings", () => {
    const d = detailsFromMasterRow(row)!;
    expect(d.model).toBe("49888");
    expect(d.collection).toBe("Speedway");
    expect(d.costCents).toBe(3500);
    expect(d.tpCents).toBe(5385);
    expect(d.weightLb).toBe(1);
    expect(d.ebayShippingProfile).toBe("eBay Live Shipping Policy Small");
  });
  it("matches headings whatever their case or spacing", () => {
    expect(detailsFromMasterRow({ " invicta model ": "50133", description: "x" })?.description).toBe("x");
  });
  it("reads a cost or price of 0 as not given", () => {
    const d = detailsFromMasterRow({ "Invicta Model": "1", Cost: 0, TP: 0 })!;
    expect([d.costCents, d.tpCents]).toEqual([null, null]);
  });
  it("skips a row with no model number", () => {
    expect(detailsFromMasterRow({ "Invicta Model": "", Description: "Totals" })).toBeNull();
  });
});

describe("loading the master over a model already there", () => {
  const blank = {
    brand: "", collection: "", series: "", gender: "", description: "", imageUrl: "", ebayShippingProfile: "",
    costCents: null, tpCents: null, msrpCents: null, weightLb: null, lengthIn: null, widthIn: null, heightIn: null,
  };
  const incoming = { ...blank, model: "1", description: "New text", costCents: 4000, tpCents: 6100 };

  it("never overwrites what the team typed in the app, but updates the rest", () => {
    const typed = { ...blank, description: "Typed by Claudia", tpCents: 5000, collection: "Old" };
    const incoming2 = { ...incoming, collection: "Pro Diver", tpCents: 6100 };
    expect(masterChanges(typed, incoming2, ["description", "tpCents"])).toEqual({ collection: "Pro Diver", costCents: 4000 });
  });
  it("updates details", () => {
    expect(masterChanges({ ...blank, description: "Old" }, incoming)).toMatchObject({ description: "New text", tpCents: 6100 });
  });
  it("fills a missing cost", () => {
    expect(masterChanges(blank, incoming).costCents).toBe(4000);
  });
  it("never changes a cost already set", () => {
    expect(masterChanges({ ...blank, costCents: 3500 }, incoming).costCents).toBeUndefined();
  });
  it("does not take a cost of 0 as a cost", () => {
    expect(masterChanges(blank, { ...incoming, costCents: 0 }).costCents).toBeUndefined();
  });
  it("leaves a detail alone when the master's cell is empty", () => {
    expect(masterChanges({ ...blank, collection: "Pro Diver" }, incoming).collection).toBeUndefined();
  });
  it("reports nothing when nothing differs", () => {
    expect(masterChanges({ ...blank, description: "New text", costCents: 4000, tpCents: 6100 }, incoming)).toEqual({});
  });
});

describe("a count", () => {
  it("writes the difference from what the app had", () => {
    expect(countLines({ SELLABLE: 10 }, { SELLABLE: 12 })).toEqual([{ place: "SELLABLE", counted: 12, qty: 2 }]);
    expect(countLines({ SELLABLE: 10 }, { SELLABLE: 7 })).toEqual([{ place: "SELLABLE", counted: 7, qty: -3 }]);
  });
  it("still writes a line when it matched, so the history shows it was counted", () => {
    expect(countLines({ DAMAGED: 2 }, { DAMAGED: 2 })).toEqual([{ place: "DAMAGED", counted: 2, qty: 0 }]);
  });
  it("leaves places that were not counted alone", () => {
    expect(countLines({ SELLABLE: 10, SAMPLE_EBAY: 1 }, { SELLABLE: 9 }).map((l) => l.place)).toEqual(["SELLABLE"]);
  });
  it("counts a model for the first time from zero", () => {
    expect(countLines({}, { SELLABLE: 24, SAMPLE_TIKTOK: 1 })).toEqual([
      { place: "SELLABLE", counted: 24, qty: 24 },
      { place: "SAMPLE_TIKTOK", counted: 1, qty: 1 },
    ]);
  });
});

describe("a new model number", () => {
  it("accepts real ones", () => {
    for (const m of ["49888", "TM-525003", "ACW8082-014", "26/P/65800/7", "C148844"]) {
      expect(badModelNumber(m)).toBeNull();
    }
  });
  it("refuses what Excel and typos make", () => {
    for (const m of ["", "TOTAL", "4.9888E+4", "LGD #1", "=SUM(A1)", "A".repeat(41)]) {
      expect(badModelNumber(m)).not.toBeNull();
    }
  });
});

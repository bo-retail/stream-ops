import { describe, expect, it } from "vitest";
import {
  placeReceived,
  soldByShow,
  startingCountLines,
  badModelNumber,
  catalogueSpelling,
  spellings,
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

describe("a report's number, in the catalogue's spelling", () => {
  const spell = catalogueSpelling(["0069", "0071", "0072", "49888", "ACW8082-014", "071", "00071", "500", "0500"]);

  it("finds 0072 for the 72 a report lost the zeros of — the 10/06 case", () => {
    expect(spell("72")).toBe("0072");
    expect(spell("069")).toBe("0069");
  });

  it("leaves a number the catalogue has exactly as it is", () => {
    expect(spell("49888")).toBe("49888");
    expect(spell("500")).toBe("500");
    expect(spell("0500")).toBe("0500");
  });

  it("does not guess between two models that differ only by zeros", () => {
    // 071, 0071 and 00071 are all "71" without their zeros.
    expect(spell("71")).toBe("71");
  });

  it("leaves letters, hyphens and unknown numbers alone", () => {
    expect(spell("ACW8082-14")).toBe("ACW8082-14");
    expect(spell("12345")).toBe("12345");
    expect(spell("")).toBe("");
  });

  it("matches either way round, only when one model fits", () => {
    // "0049888" is not in the catalogue; it is read as 49888 only because
    // 49888 is the one model it matches.
    expect(catalogueSpelling(["49888"])("0049888")).toBe("49888");
    expect(catalogueSpelling([])("0071")).toBe("0071");
  });
});

describe("looking a report's number up in the catalogue", () => {
  it("asks for 71 with and without its leading zeros", () => {
    expect(spellings("71")).toEqual(expect.arrayContaining(["71", "071", "0071", "00071"]));
    expect(spellings("0071")).toEqual(expect.arrayContaining(["0071", "71"]));
  });

  it("asks for a model with letters only as it is", () => {
    expect(spellings("ACW8043-006")).toEqual(["ACW8043-006"]);
  });

  it("finds the picture of 0071 for a listing of 71, the way the box screen asks", () => {
    const catalogue = ["0071", "49888"];
    const fetched = catalogue.filter((m) => spellings("71").includes(m));
    expect(catalogueSpelling(fetched)("71")).toBe("0071");
  });
});

describe("the starting count", () => {
  const none = { SELLABLE: 0, SAMPLE_EBAY: 0, SAMPLE_TIKTOK: 0, RANDOM_PULLS: 0, DAMAGED: 0, WAITING: 0 };

  it("leaves each place at exactly what the sheet says", () => {
    const before = { ...none, SELLABLE: 5, SAMPLE_TIKTOK: 2 };
    const lines = startingCountLines(before, { SELLABLE: 3, SAMPLE_TIKTOK: 2, SAMPLE_EBAY: 1 });
    const after = { ...before };
    for (const l of lines) after[l.place] += l.qty;
    expect(after).toEqual({ ...none, SELLABLE: 3, SAMPLE_TIKTOK: 2, SAMPLE_EBAY: 1 });
  });

  it("empties damaged and sold-waiting-to-ship, which the simple inventory does not keep", () => {
    const lines = startingCountLines({ ...none, DAMAGED: 2, WAITING: 4 }, {});
    expect(lines).toEqual([
      { place: "DAMAGED", qty: -2, counted: 0 },
      { place: "WAITING", qty: -4, counted: 0 },
    ]);
  });

  it("a blank place is none, and a model below zero is brought back up", () => {
    const lines = startingCountLines({ ...none, SELLABLE: -3, RANDOM_PULLS: 1 }, { SELLABLE: 2 });
    expect(lines).toEqual([
      { place: "SELLABLE", qty: 5, counted: 2 },
      { place: "RANDOM_PULLS", qty: -1, counted: 0 },
    ]);
  });

  it("writes nothing for a model already right", () => {
    expect(startingCountLines({ ...none, SELLABLE: 2 }, { SELLABLE: 2 })).toEqual([]);
  });
});

describe("where a delivery goes (Samuel, 10/14)", () => {
  const none = { tiktokSample: false, ebaySample: false };
  const both = { tiktokSample: true, ebaySample: true };
  const place = (s: number, t: number, e: number, r: number) => ({ SELLABLE: s, SAMPLE_TIKTOK: t, SAMPLE_EBAY: e, RANDOM_PULLS: r });

  it("a model that already has both samples: all of it Sellable", () => {
    expect(placeReceived(100, both)).toEqual(place(100, 0, 0, 0));
    expect(placeReceived(1, both)).toEqual(place(1, 0, 0, 0));
  });
  it("no samples yet, 4 or more: one of each sample, the rest Sellable", () => {
    expect(placeReceived(10, none)).toEqual(place(8, 1, 1, 0));
    expect(placeReceived(4, none)).toEqual(place(2, 1, 1, 0));
  });
  it("no samples yet, exactly 3: one of each", () => {
    expect(placeReceived(3, none)).toEqual(place(1, 1, 1, 0));
  });
  it("no samples yet, 1 or 2: Random pulls", () => {
    expect(placeReceived(1, none)).toEqual(place(0, 0, 0, 1));
    expect(placeReceived(2, none)).toEqual(place(0, 0, 0, 2));
  });
  it("one sample missing: only that one is filled", () => {
    expect(placeReceived(10, { tiktokSample: true, ebaySample: false })).toEqual(place(9, 0, 1, 0));
    expect(placeReceived(3, { tiktokSample: false, ebaySample: true })).toEqual(place(2, 1, 0, 0));
  });
  it("nothing received, nothing placed", () => {
    expect(placeReceived(0, none)).toEqual(place(0, 0, 0, 0));
  });
});

describe("soldByShow", () => {
  it("a model never sold: nothing to list", () => {
    expect(soldByShow([])).toEqual([]);
  });

  it("counts each watch once per show day and show, newest day first", () => {
    const sales = [
      { day: "2026-10-19", show: "eBay PM" },
      { day: "2026-10-20", show: "TikTok AM" },
      { day: "2026-10-19", show: "eBay PM" },
      { day: "2026-10-20", show: "TikTok AM" },
      { day: "2026-10-19", show: "eBay PM" },
    ];
    expect(soldByShow(sales)).toEqual([
      { day: "2026-10-20", show: "TikTok AM", sold: 2 },
      { day: "2026-10-19", show: "eBay PM", sold: 3 },
    ]);
  });

  it("two platforms the same day stay apart; the day's shows in the order they ran", () => {
    const sales = [
      { day: "2026-10-20", show: "TikTok PM" },
      { day: "2026-10-20", show: "eBay AM" },
      { day: "2026-10-20", show: "TikTok EARLY AM" },
      { day: "2026-10-20", show: "TikTok AM" },
      { day: "2026-10-21", show: "TikTok PM" },
    ];
    expect(soldByShow(sales).map((s) => `${s.day} ${s.show} ${s.sold}`)).toEqual([
      "2026-10-21 TikTok PM 1",
      "2026-10-20 TikTok EARLY AM 1",
      "2026-10-20 eBay AM 1",
      "2026-10-20 TikTok AM 1",
      "2026-10-20 TikTok PM 1",
    ]);
  });
});

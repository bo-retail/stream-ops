import { describe, expect, it } from "vitest";
import type { Cell, SheetRows } from "./inventory-sheets";
import {
  differences,
  offerDateFromName,
  readLineCount,
  readOffer,
  readShippingList,
  receiptChange,
  stillToCome,
  weightedCost,
} from "./receiving";

const sheet = (rows: Record<string, Cell>[], name = "Products"): SheetRows => [
  { sheet: name, rows: rows.map((values, i) => ({ line: i + 3, values })) },
];

describe("reading Daniel's offer", () => {
  // The 09.19 offer's own columns: a duplicate "Invicta Model" column (the
  // reader keeps one), "Distriutor cost" misspelt, #N/A in places.
  const row = (model: Cell, dani: Cell, cost: Cell, extra: Record<string, Cell> = {}) => ({
    "Invicta Model": model, Brand: "Invicta", "Small Main Image": null, Collection: "Pro Diver", Gender: "Men",
    "Distriutor cost": "#N/A", OH: 0, IT: 76, Dani: dani, Qty: 40, "BO COSTS": cost, ...extra,
  });

  it("takes every line Daniel ordered, at its BO COSTS", () => {
    const r = readOffer(sheet([row(1326, 40, 32), row("tm-222013", 17, 35.5)]));
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => [l.model, l.qty, l.costCents])).toEqual([["1326", 40, 3200], ["TM-222013", 17, 3550]]);
    expect(r.lines[0]).toMatchObject({ brand: "Invicta", collection: "Pro Diver", gender: "Men", imageUrl: "" });
  });
  it("skips a model he did not order: Dani blank or 0", () => {
    expect(readOffer(sheet([row(1326, null, 32), row(1515, 0, 32), row(6621, "", 32)])).lines).toEqual([]);
  });
  it("refuses, and names, a line it cannot read rather than guess", () => {
    const r = readOffer(sheet([row(1326, "forty", 32), row(1515, 2.5, 32), row(6621, 10, "#N/A"), row(7000, "#N/A", 32), row("4.89E+04", 5, 32)]));
    expect(r.lines).toEqual([]);
    expect(r.problems).toHaveLength(5);
    expect(r.problems.join(" ")).toContain("Products row 5 (6621): ordered 10 but BO COSTS has no cost");
    expect(r.problems.join(" ")).toContain("Excel changed");
  });
  it("adds up a model listed twice at the same cost, and refuses two costs", () => {
    expect(readOffer(sheet([row(1326, 10, 32), row(1326, 5, 32)])).lines[0].qty).toBe(15);
    expect(readOffer(sheet([row(1326, 10, 32), row(1326, 5, 30)])).problems).toHaveLength(1);
  });
  it("keeps a picture link only if it really is one", () => {
    const r = readOffer(sheet([row(1326, 1, 32, { "Small Main Image": "https://cdn.invictawatch.com/a.jpg" }), row(1515, 1, 32, { "Small Main Image": "#N/A" })]));
    expect(r.lines.map((l) => l.imageUrl)).toEqual(["https://cdn.invictawatch.com/a.jpg", ""]);
  });
});

describe("an offer's date from its file name", () => {
  it("reads the date Daniel names it by", () => {
    expect(offerDateFromName("09.19 BO retail offer_.xlsx", "2026-10-01")).toBe("2026-09-19");
    expect(offerDateFromName("BO offer 10-02.xlsx", "2026-10-01")).toBe("2026-10-02");
    expect(offerDateFromName("offer 1.5.27.xlsx", "2026-10-01")).toBe("2027-01-05");
  });
  it("puts a December offer opened in January in last year", () => {
    expect(offerDateFromName("12.20 offer.xlsx", "2027-01-03")).toBe("2026-12-20");
  });
  it("gives up on a name with no date, or an impossible one, so the page asks", () => {
    expect(offerDateFromName("BO retail offer.xlsx", "2026-10-01")).toBeNull();
    expect(offerDateFromName("02.31 offer.xlsx", "2026-10-01")).toBeNull();
    expect(offerDateFromName("13.01 offer.xlsx", "2026-10-01")).toBeNull();
  });
});

describe("reading Invicta's shipping list", () => {
  const row = (sop: Cell, item: Cell, qty: Cell, price: Cell) => ({ "SOP Number": sop, "Customer PO Number": "9.15 ORDER", Item: item, Quantity: qty, "Unit Price": price });

  it("one shipment per SOP, with what they say they sent and its price", () => {
    const r = readShippingList(sheet([row("INV258905", "TM-222013", 17, 35), row("inv258905", 10786, 5, 120), row("INV260112", "49604", 15, "$58.00")], "Sheet1"));
    expect(r.problems).toEqual([]);
    expect(r.shipments).toEqual([
      { sop: "INV258905", po: "9.15 ORDER", lines: [{ model: "TM-222013", qty: 17, unitCostCents: 3500 }, { model: "10786", qty: 5, unitCostCents: 12000 }] },
      { sop: "INV260112", po: "9.15 ORDER", lines: [{ model: "49604", qty: 15, unitCostCents: 5800 }] },
    ]);
  });
  it("skips a totals row and adds up a model listed twice at one price", () => {
    const r = readShippingList(sheet([row("INV1", "49604", 10, 58), row("INV1", "49604", 5, 58), row(null, null, 15, null)]));
    expect(r.shipments[0].lines).toEqual([{ model: "49604", qty: 15, unitCostCents: 5800 }]);
  });
  it("refuses a model at two prices, a missing price or quantity, and a lost SOP", () => {
    const r = readShippingList(sheet([row("INV1", "49604", 10, 58), row("INV1", "49604", 5, 60), row("INV1", "1", null, 5), row("INV1", "2", 3, "#N/A"), row(null, "3", 1, 5)]));
    expect(r.problems).toHaveLength(4);
  });
});

describe("a shipment count", () => {
  it("reads counted and damaged, damaged being part of counted", () => {
    expect(readLineCount(17, null)).toEqual({ ok: true, count: { counted: 17, damaged: 0 } });
    expect(readLineCount("17", "2")).toEqual({ ok: true, count: { counted: 17, damaged: 2 } });
    expect(readLineCount("", "")).toEqual({ ok: "blank" });
    expect(readLineCount(0, null)).toEqual({ ok: true, count: { counted: 0, damaged: 0 } });
  });
  it("refuses damaged above counted, damaged with nothing counted, and anything not a whole number", () => {
    expect(readLineCount(2, 3).ok).toBe(false);
    expect(readLineCount(null, 1).ok).toBe(false);
    expect(readLineCount("17.5", null).ok).toBe(false);
    expect(readLineCount(-1, null).ok).toBe(false);
  });
  it("moves good pieces to Sellable and damaged ones to Damaged", () => {
    expect(receiptChange(null, { counted: 17, damaged: 2 })).toEqual({ sellable: 15, damaged: 2, pieces: 17 });
  });
  it("a corrected count moves only the difference, and the same count twice moves nothing", () => {
    expect(receiptChange({ counted: 17, damaged: 2 }, { counted: 16, damaged: 1 })).toEqual({ sellable: 0, damaged: -1, pieces: -1 });
    expect(receiptChange({ counted: 17, damaged: 2 }, { counted: 17, damaged: 2 })).toEqual({ sellable: 0, damaged: 0, pieces: 0 });
    expect(receiptChange({ counted: 17, damaged: 2 }, { counted: 0, damaged: 0 })).toEqual({ sellable: -15, damaged: -2, pieces: -17 });
  });
});

describe("cost after a shipment", () => {
  it("is the weighted average of what was here and what came", () => {
    expect(weightedCost(3000, 10, 4000, 10)).toBe(3500);
    expect(weightedCost(3000, 30, 4000, 10)).toBe(3250);
  });
  it("is the new price when nothing was on hand or there was no cost", () => {
    expect(weightedCost(3000, 0, 4000, 5)).toBe(4000);
    expect(weightedCost(null, 7, 4000, 5)).toBe(4000);
  });
  it("is unchanged with no price, nothing received, or at the same price", () => {
    expect(weightedCost(3000, 10, null, 5)).toBe(3000);
    expect(weightedCost(3000, 10, 4000, 0)).toBe(3000);
    expect(weightedCost(3500, 10, 3500, 4)).toBe(3500);
  });
  it("a model sold before its shipment was counted (nothing or less than nothing on hand) takes the new price", () => {
    expect(weightedCost(3000, -3, 4000, 10)).toBe(4000);
    expect(weightedCost(3000, -3, 4000, -2)).toBe(3000);
  });
  it("a count corrected back puts the cost back where it was", () => {
    const after = weightedCost(3000, 10, 4000, 10)!;
    expect(weightedCost(after, 20, 4000, -10)).toBe(3000);
  });
});

describe("differences with Invicta", () => {
  it("none until counted, none when it matches", () => {
    expect(differences({ listedQty: 17, countedQty: null, damagedQty: null })).toEqual([]);
    expect(differences({ listedQty: 17, countedQty: 17, damagedQty: 0 })).toEqual([]);
  });
  it("short, over, damaged, and a model that was not on the list", () => {
    expect(differences({ listedQty: 17, countedQty: 15, damagedQty: 0 })).toEqual([{ kind: "short", qty: 2 }]);
    expect(differences({ listedQty: 17, countedQty: 18, damagedQty: 1 })).toEqual([{ kind: "over", qty: 1 }, { kind: "damaged", qty: 1 }]);
    expect(differences({ listedQty: 0, countedQty: 3, damagedQty: 0 })).toEqual([{ kind: "not on the list", qty: 3 }]);
    expect(differences({ listedQty: 5, countedQty: 0, damagedQty: 0 })).toEqual([{ kind: "short", qty: 5 }]);
  });
});

describe("still to come", () => {
  const today = "2026-10-01";
  it("what was ordered and not yet on any shipping list", () => {
    const r = stillToCome([{ date: "2026-09-19", lines: [{ model: "1326", qty: 40 }, { model: "1515", qty: 30 }] }], [{ date: "2026-09-25", model: "1326", qty: 25 }], today);
    expect(r).toEqual([
      { model: "1326", offerDate: "2026-09-19", ordered: 40, shipped: 25, toCome: 15 },
      { model: "1515", offerDate: "2026-09-19", ordered: 30, shipped: 0, toCome: 30 },
    ]);
  });
  it("a shipment from before the offer does not fill it", () => {
    expect(stillToCome([{ date: "2026-09-19", lines: [{ model: "1326", qty: 40 }] }], [{ date: "2026-09-16", model: "1326", qty: 40 }], today)[0].toCome).toBe(40);
  });
  it("two offers of one model fill oldest first, each shipped piece used once", () => {
    const r = stillToCome(
      [{ date: "2026-09-01", lines: [{ model: "1326", qty: 10 }] }, { date: "2026-09-19", lines: [{ model: "1326", qty: 10 }] }],
      [{ date: "2026-09-20", model: "1326", qty: 15 }],
      today,
    );
    expect(r).toEqual([{ model: "1326", offerDate: "2026-09-19", ordered: 10, shipped: 5, toCome: 5 }]);
  });
  it("an offer over 60 days old drops off, whatever is left on it", () => {
    expect(stillToCome([{ date: "2026-08-01", lines: [{ model: "1326", qty: 10 }] }], [], today)).toEqual([]);
    expect(stillToCome([{ date: "2026-08-02", lines: [{ model: "1326", qty: 10 }] }], [], today)).toHaveLength(1);
  });
  it("a day with no offers has nothing to come", () => {
    expect(stillToCome([], [{ date: "2026-09-20", model: "1326", qty: 15 }], today)).toEqual([]);
  });
});

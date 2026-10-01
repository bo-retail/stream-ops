import { describe, expect, it } from "vitest";
import type { Place } from "./inventory";
import { isBlankRow, prompts, readAdjustment, readMove, readOrder, readPlace, readReturn } from "./movements";

const stock = (over: Partial<Record<Place, number>> = {}): Record<Place, number> => ({
  SELLABLE: 0, SAMPLE_EBAY: 0, SAMPLE_TIKTOK: 0, RANDOM_PULLS: 0, DAMAGED: 0, ...over,
});

describe("a place, as people write it", () => {
  it("reads the screen's names and the usual short forms", () => {
    expect(["Sellable", "shelf", "Inventory", "eBay sample", "Sample TikTok", "tiktok", "Random Pulls", "random pull", "Damaged", "SAMPLE_EBAY"].map(readPlace)).toEqual([
      "SELLABLE", "SELLABLE", "SELLABLE", "SAMPLE_EBAY", "SAMPLE_TIKTOK", "SAMPLE_TIKTOK", "RANDOM_PULLS", "RANDOM_PULLS", "DAMAGED", "SAMPLE_EBAY",
    ]);
    expect(readPlace("the back room")).toBeNull();
  });
});

describe("a move", () => {
  const row = { "Model #": " 49888 ", Quantity: "1", From: "Sellable", To: "eBay sample", Reason: "sample pulled", Note: "for tonight" };
  it("reads a good row", () => {
    expect(readMove(row)).toEqual({ ok: true, move: { model: "49888", qty: 1, from: "SELLABLE", to: "SAMPLE_EBAY", reason: "Sample pulled", note: "for tonight" } });
  });
  it("refuses the same place twice, a reason not on the list, a quantity that is not a whole number, a missing place", () => {
    expect(readMove({ ...row, To: "Sellable" }).ok).toBe(false);
    expect(readMove({ ...row, Reason: "felt like it" }).ok).toBe(false);
    expect(readMove({ ...row, Quantity: "1.5" }).ok).toBe(false);
    expect(readMove({ ...row, Quantity: "0" }).ok).toBe(false);
    expect(readMove({ ...row, From: "" }).ok).toBe(false);
    expect(readMove({ ...row, "Model #": "" }).ok).toBe(false);
  });
});

describe("an adjustment", () => {
  const row = { "Model #": "49888", Action: "Subtract", Quantity: 2, Place: "Sellable", Reason: "Giveaway" };
  it("takes away, or adds, with a reason", () => {
    expect(readAdjustment(row)).toMatchObject({ ok: true, adjustment: { qty: -2, place: "SELLABLE", reason: "Giveaway" } });
    expect(readAdjustment({ ...row, Action: "add", Reason: "Found" })).toMatchObject({ ok: true, adjustment: { qty: 2 } });
    expect(readAdjustment({ ...row, Action: "Add", Reason: "Miscount" })).toMatchObject({ ok: true, adjustment: { qty: 2 } });
  });
  it("the place defaults to the shelf", () => {
    expect(readAdjustment({ ...row, Place: "" })).toMatchObject({ ok: true, adjustment: { place: "SELLABLE" } });
  });
  it("a giveaway cannot add, found cannot take away, damaged cannot come out of Damaged", () => {
    expect(readAdjustment({ ...row, Action: "Add" }).ok).toBe(false);
    expect(readAdjustment({ ...row, Reason: "Found" }).ok).toBe(false);
    expect(readAdjustment({ ...row, Reason: "Damaged", Place: "Damaged" }).ok).toBe(false);
    expect(readAdjustment({ ...row, Action: "Borrow" }).ok).toBe(false);
  });
});

describe("a return or cancellation", () => {
  const row = { "Model #": "49888", Quantity: "1", Type: "Back in stock", "Goes to": "Random pulls", "Order #": "#577301", "Condition / note": "scratched bezel" };
  it("back in stock, where Gladys put it, tied to its order", () => {
    expect(readReturn(row)).toEqual({ ok: true, ret: { model: "49888", qty: 1, type: "Back in stock", to: "RANDOM_PULLS", order: "577301", note: "scratched bezel" } });
  });
  it("older words still work: return, cancelled, refund, exchange", () => {
    expect(readReturn({ ...row, Type: "Cancelled" })).toMatchObject({ ret: { type: "Back in stock" } });
    expect(readReturn({ ...row, Type: "refund" })).toMatchObject({ ret: { type: "Refund only", to: null } });
    expect(readReturn({ ...row, Type: "Exchange" })).toMatchObject({ ret: { type: "Exchange / reship", to: null } });
  });
  it("back in stock needs Goes to; an unknown type is refused", () => {
    expect(readReturn({ ...row, "Goes to": "" }).ok).toBe(false);
    expect(readReturn({ ...row, Type: "Lost in post" }).ok).toBe(false);
  });
  it("a blank line at the bottom of a sheet is just blank", () => {
    expect(isBlankRow({ "Model #": "", Quantity: null, Type: " " })).toBe(true);
  });
});

describe("what Gladys is asked", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const recent = new Date("2026-10-07T12:00:00Z");
  it("a new model with stock and no samples: pull one for each table", () => {
    const p = prompts([{ model: "49888", balances: stock({ SELLABLE: 10 }), firstReceived: recent }], now);
    expect(p).toHaveLength(1);
    expect(p[0].moves.map((m) => m.to)).toEqual(["SAMPLE_EBAY", "SAMPLE_TIKTOK"]);
  });
  it("a new model of a single piece: only one sample", () => {
    expect(prompts([{ model: "49888", balances: stock({ SELLABLE: 1 }), firstReceived: recent }], now)[0].moves).toHaveLength(1);
  });
  it("a model already stocked before, or new with both samples out: nothing to ask", () => {
    expect(prompts([{ model: "49888", balances: stock({ SELLABLE: 10 }), firstReceived: new Date("2026-08-01") }], now)).toEqual([]);
    expect(prompts([{ model: "49888", balances: stock({ SELLABLE: 10, SAMPLE_EBAY: 1, SAMPLE_TIKTOK: 1 }), firstReceived: recent }], now)).toEqual([]);
  });
  it("the shelf ran out with samples on the tables: move them to random pulls?", () => {
    const p = prompts([{ model: "49888", balances: stock({ SAMPLE_EBAY: 1, SAMPLE_TIKTOK: 1 }), firstReceived: null, lastShelfSale: recent }], now);
    expect([p[0].kind, p[0].moves.map((m) => [m.from, m.to, m.qty])]).toEqual(["samples to random pulls", [["SAMPLE_EBAY", "RANDOM_PULLS", 1], ["SAMPLE_TIKTOK", "RANDOM_PULLS", 1]]]);
  });
  it("nothing on the shelf and no samples: nothing to ask", () => {
    expect(prompts([{ model: "49888", balances: stock({ RANDOM_PULLS: 2 }), firstReceived: null }], now)).toEqual([]);
  });
});

describe("after the review", () => {
  it("an order number as people type or paste it", () => {
    expect([readOrder("#577301"), readOrder("# 5773 01 "), readOrder(577301), readOrder("577301.0"), readOrder(null)]).toEqual([
      { ok: true, order: "577301" }, { ok: true, order: "577301" }, { ok: true, order: "577301" }, { ok: true, order: "577301" }, { ok: true, order: "" },
    ]);
  });
  it("an order number Excel already rounded is refused, not matched to the wrong order", () => {
    expect(readOrder(576997123456789012).ok).toBe(false);
    expect(readOrder("5.76997E+17").ok).toBe(false);
  });
  it("a cancellation needs its order number; a plain return does not", () => {
    const row = { "Model #": "49888", Quantity: 1, "Goes to": "Sellable" };
    expect(readReturn({ ...row, Type: "Cancelled" }).ok).toBe(false);
    expect(readReturn({ ...row, Type: "Back in stock" }).ok).toBe(true);
    expect(readReturn({ ...row, Type: "Cancelled", "Order #": 577301 }).ok).toBe(true);
  });
  it("written off / credited clears Damaged, and can only take away", () => {
    expect(readAdjustment({ "Model #": "49888", Action: "Subtract", Quantity: 1, Place: "Damaged", Reason: "Written off / credited" }).ok).toBe(true);
    expect(readAdjustment({ "Model #": "49888", Action: "Add", Quantity: 1, Place: "Damaged", Reason: "Written off / credited" }).ok).toBe(false);
  });
  it("a shelf at zero is only asked about if it ran out by selling lately — not after the opening count", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    const base = { model: "49888", balances: stock({ SAMPLE_EBAY: 1 }), firstReceived: null };
    expect(prompts([base], now)).toEqual([]);
    expect(prompts([{ ...base, lastShelfSale: new Date("2026-08-01") }], now)).toEqual([]);
    expect(prompts([{ ...base, lastShelfSale: new Date("2026-10-07") }], now)).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { buildBoxes, checkIntegrity, summariseDay } from "./boxes";
import type { WatchSale } from "./types";

function sale(overrides: Partial<WatchSale> = {}): WatchSale {
  return {
    platform: "TIKTOK",
    show: "TikTok AM",
    showDate: "2026-09-08",
    shiftTag: "09.08.26 AM",
    rawShiftTag: "09.08.26 AM",
    shiftTagValid: true,
    orderRef: "order-1",
    lineRef: "line-1",
    buyer: "test.buyer",
    stockNumber: "45874",
    category: "Quartz Watches",
    qty: 1,
    unitPrice: 41,
    platformDiscount: 0,
    sellerDiscount: 0,
    netItemPrice: 41,
    shipping: 8.99,
    taxAndFees: 3.06,
    orderTotal: 53.05,
    createdAt: null,
    paidOn: "2026-09-08",
    shipToName: "T**** B****",
    state: "Illinois",
    paymentMethod: "ApplePay",
    packageId: "pkg-1",
    tracking: "9234690390470910236904",
    sourceFile: "test.csv",
    ...overrides,
  };
}

describe("building boxes", () => {
  it("puts several orders sharing a tracking number in one box", () => {
    const boxes = buildBoxes([
      sale({ orderRef: "a", stockNumber: "45874" }),
      sale({ orderRef: "b", stockNumber: "50855" }),
    ]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].watchCount).toBe(2);
    expect(boxes[0].orderRefs).toEqual(["a", "b"]);
  });

  it("counts a repeated stock number rather than listing it twice", () => {
    // A real 09/08 box held 49746 three times and 48080 twice. As a tick-list
    // the second scan of an identical barcode looks like a duplicate and gets
    // refused, stranding the packer.
    const boxes = buildBoxes([
      sale({ orderRef: "a", stockNumber: "49746" }),
      sale({ orderRef: "b", stockNumber: "49746" }),
      sale({ orderRef: "c", stockNumber: "49746" }),
      sale({ orderRef: "d", stockNumber: "48080" }),
      sale({ orderRef: "e", stockNumber: "48080" }),
    ]);
    expect(boxes[0].items).toEqual([
      { stockNumber: "48080", expected: 2 },
      { stockNumber: "49746", expected: 3 },
    ]);
    expect(boxes[0].watchCount).toBe(5);
  });

  it("folds case so a barcode reader's casing cannot cause a mis-pick", () => {
    const boxes = buildBoxes([
      sale({ orderRef: "a", stockNumber: "acw8105mc-001" }),
      sale({ orderRef: "b", stockNumber: "ACW8105MC-001" }),
    ]);
    expect(boxes[0].items).toEqual([{ stockNumber: "ACW8105MC-001", expected: 2 }]);
  });

  it("records a box holding watches from both of a day's shows", () => {
    // 16 boxes did this on 09/08 — which is why the box list is per day and
    // there is no per-show packing screen.
    const boxes = buildBoxes([
      sale({ orderRef: "a", show: "TikTok AM" }),
      sale({ orderRef: "b", show: "TikTok PM", stockNumber: "50504" }),
    ]);
    expect(boxes[0].shows).toEqual(["TikTok AM", "TikTok PM"]);
  });

  it("takes the ship-to from whichever row has one", () => {
    // eBay item rows are blank in it; the summary row supplies it.
    const boxes = buildBoxes([
      sale({ orderRef: "a", shipToName: "", state: "" }),
      sale({ orderRef: "b", shipToName: "Real Name", state: "SC", stockNumber: "50855" }),
    ]);
    expect(boxes[0].shipToName).toBe("Real Name");
    expect(boxes[0].state).toBe("SC");
  });

  it("ignores a sale with no tracking rather than inventing a box for it", () => {
    expect(buildBoxes([sale({ tracking: "" })])).toHaveLength(0);
  });
});

describe("integrity checks", () => {
  it("passes clean data", () => {
    const sales = [sale()];
    expect(checkIntegrity(sales, buildBoxes(sales))).toEqual([]);
  });

  it("blocks when a paid watch has no tracking number", () => {
    const sales = [sale({ tracking: "" })];
    const flags = checkIntegrity(sales, buildBoxes(sales));
    expect(flags[0].severity).toBe("blocking");
    expect(flags[0].message).toContain("no tracking number");
  });

  it("blocks when a paid watch has no stock number, since it cannot be scanned", () => {
    const sales = [sale({ stockNumber: "" })];
    const flags = checkIntegrity(sales, buildBoxes(sales));
    expect(flags.some((f) => f.severity === "blocking" && f.message.includes("no stock number"))).toBe(true);
  });

  it("blocks when one box would go to two different buyers", () => {
    const sales = [sale({ orderRef: "a", buyer: "one" }), sale({ orderRef: "b", buyer: "two" })];
    const flags = checkIntegrity(sales, buildBoxes(sales));
    expect(flags.some((f) => f.severity === "blocking" && f.message.includes("different buyers"))).toBe(true);
  });

  it("blocks when one tracking number mixes marketplaces", () => {
    const sales = [
      sale({ orderRef: "a", platform: "TIKTOK" }),
      sale({ orderRef: "b", platform: "EBAY", show: "eBay PM" }),
    ];
    const flags = checkIntegrity(sales, buildBoxes(sales));
    expect(flags.some((f) => f.message.includes("mixes"))).toBe(true);
  });

  it("warns if a tracking number ever ends with another one", () => {
    const sales = [
      sale({ orderRef: "a", tracking: "999234690390470910236904" }),
      sale({ orderRef: "b", tracking: "9234690390470910236904" }),
    ];
    const flags = checkIntegrity(sales, buildBoxes(sales));
    expect(flags.some((f) => f.message.includes("end with another tracking number"))).toBe(true);
  });

  it("checks the arithmetic per order, so a multi-item order still balances", () => {
    // An eBay multi-item order carries its shipping, tax and total on the first
    // watch only. Checked row by row, every continuation line would fail.
    const sales = [
      sale({ platform: "EBAY", orderRef: "29462", netItemPrice: 12, shipping: 12.98, taxAndFees: 1.56, orderTotal: 40.54, tracking: "t1" }),
      sale({ platform: "EBAY", orderRef: "29462", netItemPrice: 14, shipping: 0, taxAndFees: 0, orderTotal: 0, tracking: "t1", stockNumber: "x" }),
    ];
    expect(checkIntegrity(sales, buildBoxes(sales))).toEqual([]);
  });

  it("warns when an order genuinely does not add up, without correcting it", () => {
    const sales = [sale({ netItemPrice: 41, shipping: 8.99, taxAndFees: 3.06, orderTotal: 99 })];
    const flags = checkIntegrity(sales, buildBoxes(sales));
    expect(flags.some((f) => f.severity === "warning" && f.message.includes("do not add up"))).toBe(true);
  });
});

describe("the day summary", () => {
  it("counts watches, boxes and the boxes spanning shows", () => {
    const sales = [
      sale({ orderRef: "a", show: "TikTok AM" }),
      sale({ orderRef: "b", show: "TikTok PM", stockNumber: "50504" }),
      sale({ orderRef: "c", platform: "EBAY", show: "eBay PM", tracking: "9434608106245552015332" }),
    ];
    const summary = summariseDay(sales, buildBoxes(sales));
    expect(summary.watches).toBe(3);
    expect(summary.boxes).toBe(2);
    expect(summary.boxesSpanningShows).toBe(1);
    expect(summary.largestBox).toBe(2);
    expect(summary.byPlatform).toEqual([
      { platform: "TIKTOK", watches: 2, boxes: 1 },
      { platform: "EBAY", watches: 1, boxes: 1 },
    ]);
  });
});

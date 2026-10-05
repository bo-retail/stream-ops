import { describe, expect, it } from "vitest";
import { saleKey } from "./deduction";
import { averagePrice, grossMargin, marginRate, morningFigures, type MorningLine, type SoldUnit } from "./morning";

const DAY = "2026-10-03";
const line = (over: Partial<MorningLine> = {}): MorningLine => ({
  platform: "TIKTOK", show: "TikTok AM", orderRef: "O1", lineRef: "1", showDate: DAY, stockNumber: "49888", modelNumber: "", tracking: "",
  qty: 1, netCents: 5_000, batchId: "b1", uploadedAt: 1,
  ...over,
});
const sold = (entries: [string, SoldUnit][]) => new Map(entries);
const costs = (entries: [string, number | null][] = []) => new Map(entries);
const day = (lines: MorningLine[], s = sold([]), c = costs(), d = DAY) => morningFigures(lines, s, c, [d]).get(d)!;

describe("the morning numbers", () => {
  it("costs each unit at the snapshot taken when it came off stock, not today's cost", () => {
    const { total } = day([line()], sold([[saleKey("TIKTOK", "O1", "49888", 0), { status: "SENT", costCents: 2_000 }]]), costs([["49888", 9_999]]));
    expect(total).toMatchObject({ revenueCents: 5_000, units: 1, cogsCents: 2_000, costedRevenueCents: 5_000, estimatedUnits: 0 });
    expect(grossMargin(total)).toBe(3_000);
    expect(marginRate(total)).toBeCloseTo(0.6);
  });

  it("matches the second and third watch of an order to their own sales (a line of two, and a second line)", () => {
    const k = (n: number) => saleKey("TIKTOK", "O1", "49888", n);
    const { total } = day(
      [line({ qty: 2, netCents: 10_001 }), line({ lineRef: "2", netCents: 4_000 })],
      sold([[k(0), { status: "SOLD", costCents: 1_000 }], [k(1), { status: "SOLD", costCents: 1_100 }], [k(2), { status: "SOLD", costCents: 1_200 }]]),
    );
    expect(total).toMatchObject({ revenueCents: 14_001, units: 3, cogsCents: 3_300 });
  });

  it("leaves a cancelled order out of everything, and counts it", () => {
    const { total } = day(
      [line(), line({ orderRef: "O2", netCents: 7_000 })],
      sold([
        [saleKey("TIKTOK", "O1", "49888", 0), { status: "CANCELLED", costCents: 2_000 }],
        [saleKey("TIKTOK", "O2", "49888", 0), { status: "SENT", costCents: 2_000 }],
      ]),
    );
    expect(total).toMatchObject({ revenueCents: 7_000, units: 1, cogsCents: 2_000, cancelledUnits: 1, cancelledCents: 5_000 });
  });

  it("keeps a returned watch's sale on its day", () => {
    const { total } = day([line()], sold([[saleKey("TIKTOK", "O1", "49888", 0), { status: "RETURNED", costCents: 2_000 }]]));
    expect(total).toMatchObject({ units: 1, cogsCents: 2_000 });
  });

  it("uses today's cost where there is no snapshot (before the start date), and counts it", () => {
    expect(day([line()], sold([]), costs([["49888", 2_500]])).total).toMatchObject({ cogsCents: 2_500, estimatedUnits: 1, uncostedUnits: 0 });
  });

  it("costs a random pull by the watch its Model # names, one per unit", () => {
    const { total } = day(
      [line({ stockNumber: "#300 - Invicta Random Pulls", modelNumber: "40022;45802", qty: 2, netCents: 3_000 })],
      sold([]),
      costs([["40022", 500], ["45802", 700]]),
    );
    expect(total).toMatchObject({ units: 2, cogsCents: 1_200, estimatedUnits: 2 });
  });

  it("costs a listing whose title names the model (\"Invicta 48912 Pro Diver\") as that model", () => {
    const { total } = day([line({ stockNumber: "Invicta 48912 Pro Diver" })], sold([]), costs([["48912", 1_500]]));
    expect(total).toMatchObject({ cogsCents: 1_500, estimatedUnits: 1, uncostedUnits: 0, unnamedUnits: 0 });
  });

  it("keeps a model with no cost and an unnamed random pull out of the margin, counted apart", () => {
    const { total } = day(
      [line(), line({ orderRef: "O2", stockNumber: "11111" }), line({ orderRef: "O3", stockNumber: "#12 - Invicta Random Pulls" })],
      sold([]),
      costs([["49888", 2_000], ["11111", null]]),
    );
    expect(total).toMatchObject({ revenueCents: 15_000, units: 3, costedRevenueCents: 5_000, cogsCents: 2_000, uncostedUnits: 1, unnamedUnits: 1 });
    expect(marginRate(total)).toBeCloseTo(0.6);
  });

  it("splits the day per show and adds up to the total", () => {
    const { byShow, total } = day([line(), line({ orderRef: "O2", show: "eBay PM", platform: "EBAY", netCents: 9_000 })], sold([]), costs([["49888", 1_000]]));
    expect(byShow.get("TikTok AM")!.revenueCents + byShow.get("eBay PM")!.revenueCents).toBe(total.revenueCents);
    expect(averagePrice(total)).toBe(7_000);
  });

  it("a day with nothing gives nothing, without dividing by zero", () => {
    const { total } = day([]);
    expect([total.revenueCents, marginRate(total), averagePrice(total)]).toEqual([0, null, null]);
  });

  it("a sale undone by a corrected report is costed like one with no snapshot", () => {
    const { total } = day([line()], sold([[saleKey("TIKTOK", "O1", "49888", 0), { status: "UNDONE", costCents: 2_000 }]]), costs([["49888", 3_000]]));
    expect(total).toMatchObject({ cogsCents: 3_000, estimatedUnits: 1 });
  });
});

describe("the units are the ones stock deduction sees (review, 4 October)", () => {
  it("the same order in two current files (overlapping downloads) counts once, from the latest", () => {
    const { total } = day(
      [line({ batchId: "b1", uploadedAt: 1 }), line({ batchId: "b2", uploadedAt: 2, show: "TikTok PM", netCents: 5_000 })],
      sold([]),
      costs([["49888", 2_000]]),
    );
    expect(total).toMatchObject({ revenueCents: 5_000, units: 1, cogsCents: 2_000 });
  });

  it("an order whose latest upload is another day is reported on that day only, at its own snapshot", () => {
    const PULLS = "#300 - Invicta Random Pulls";
    const lines = [
      line({ platform: "EBAY", show: "eBay PM", stockNumber: PULLS, modelNumber: "PA", showDate: "2026-10-02", batchId: "b2", uploadedAt: 2 }),
      line({ platform: "EBAY", show: "eBay PM", stockNumber: PULLS, modelNumber: "PB", showDate: DAY, batchId: "b3", uploadedAt: 3 }),
    ];
    const s = sold([[saleKey("EBAY", "O1", PULLS, 0), { status: "SOLD", costCents: 2_500 }]]);
    const both = morningFigures(lines, s, costs([["PA", 500], ["PB", 2_500]]), ["2026-10-02", DAY]);
    // Deduction takes the latest line only; so do the numbers — never day 2 at day 3's cost.
    expect(both.get("2026-10-02")!.total.units).toBe(0);
    expect(both.get(DAY)!.total).toMatchObject({ units: 1, cogsCents: 2_500, estimatedUnits: 0 });
  });

  it("two lines nothing tells apart (an eBay line id Excel rounded) are read in the order given, every time", () => {
    const k0 = saleKey("EBAY", "O1", "49888", 0);
    const lines = [line({ platform: "EBAY", lineRef: "1.00851E+13", netCents: 3_000 }), line({ platform: "EBAY", lineRef: "1.00851E+13", netCents: 9_000 })];
    const r = () => day(lines, sold([[k0, { status: "CANCELLED", costCents: 1_000 }]])).total;
    expect(r()).toMatchObject({ revenueCents: 9_000, cancelledCents: 3_000 });
    expect(r()).toEqual(r());
  });
});

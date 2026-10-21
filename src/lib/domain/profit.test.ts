import { describe, expect, it } from "vitest";
import { grossMargin, marginRate, type CostedUnit } from "./morning";
import { marginMovement, moneyMovement, profitReport, slowMovers } from "./profit";

const unit = (over: Partial<CostedUnit> = {}): CostedUnit => ({
  day: "2026-10-20",
  show: "TikTok PM",
  platform: "TIKTOK",
  model: "49888",
  cents: 8_000,
  costCents: 4_800,
  estimated: false,
  cancelled: false,
  ...over,
});

describe("profitReport", () => {
  it("adds up revenue, cost and margin", () => {
    const r = profitReport([unit(), unit({ cents: 7_000, costCents: 4_800 })]);
    expect(r.total).toMatchObject({ revenueCents: 15_000, cogsCents: 9_600, units: 2 });
    expect(grossMargin(r.total)).toBe(5_400);
    expect(marginRate(r.total)).toBeCloseTo(0.36, 6);
  });

  it("splits by platform, show, day and model", () => {
    const r = profitReport([
      unit(),
      unit({ platform: "EBAY", show: "eBay AM", model: "70271", cents: 3_000, costCents: 2_000 }),
      unit({ day: "2026-10-21" }),
    ]);
    expect(r.byPlatform.get("TIKTOK")!.units).toBe(2);
    expect(r.byPlatform.get("EBAY")!.revenueCents).toBe(3_000);
    expect(r.byShow.get("eBay AM")!.cogsCents).toBe(2_000);
    expect(r.byDay.get("2026-10-21")!.units).toBe(1);
    expect(r.byModel.get("49888")!.units).toBe(2);
  });

  it("counts units sold below cost", () => {
    const r = profitReport([unit({ cents: 4_000, costCents: 4_800 }), unit()]);
    expect(r.byModel.get("49888")!.belowCostUnits).toBe(1);
  });

  it("a cancelled order is left out of revenue and margin, and counted", () => {
    const r = profitReport([unit({ cancelled: true, costCents: null }), unit()]);
    expect(r.total).toMatchObject({ units: 1, revenueCents: 8_000, cancelledUnits: 1, cancelledCents: 8_000 });
    expect(r.byModel.get("49888")!.belowCostUnits).toBe(0);
  });

  it("a watch with no cost counts in revenue, not in margin", () => {
    const r = profitReport([unit({ costCents: null }), unit()]);
    expect(r.total).toMatchObject({ revenueCents: 16_000, costedRevenueCents: 8_000, uncostedUnits: 1 });
    expect(marginRate(r.total)).toBeCloseTo(0.4, 6);
  });

  it("a random pull nothing names is not a model", () => {
    const r = profitReport([unit({ model: null, costCents: null })]);
    expect(r.byModel.size).toBe(0);
    expect(r.total.unnamedUnits).toBe(1);
  });

  it("an empty period is all zero, with no margin", () => {
    const r = profitReport([]);
    expect(r.total.units).toBe(0);
    expect(marginRate(r.total)).toBeNull();
  });
});

describe("slowMovers (Daniel: two or fewer a show, under 27%, seven days)", () => {
  const week = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"];

  it("flags a watch selling one a show at a thin margin", () => {
    const units = week.map((day) => unit({ day, model: "SLOW", cents: 5_000, costCents: 4_000 }));
    const s = slowMovers(units, week);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ model: "SLOW", shows: 7, units: 7, unitsPerShow: 1 });
    expect(s[0].margin).toBeCloseTo(0.2, 6);
  });

  it("a thin margin but selling three a show is not slow", () => {
    const units = week.flatMap((day) => [1, 2, 3].map(() => unit({ day, model: "FAST", cents: 5_000, costCents: 4_000 })));
    expect(slowMovers(units, week)).toEqual([]);
  });

  it("slow but at a good margin is not flagged", () => {
    const units = week.map((day) => unit({ day, cents: 8_000, costCents: 4_000 }));
    expect(slowMovers(units, week)).toEqual([]);
  });

  it("exactly 27% is not under 27%", () => {
    expect(slowMovers([unit({ cents: 10_000, costCents: 7_300 })], week)).toEqual([]);
    expect(slowMovers([unit({ cents: 10_000, costCents: 7_301 })], week)).toHaveLength(1);
  });

  it("only the shows it sold in count: sitting out a show does not slow it", () => {
    // Two shows with two each: two a show, whatever happened at the other shows.
    const units = [1, 2].flatMap(() => [unit({ day: "2026-10-15" }), unit({ day: "2026-10-18" })]).map((u) => ({ ...u, cents: 5_000, costCents: 4_000 }));
    expect(slowMovers(units, week)[0]).toMatchObject({ shows: 2, units: 4, unitsPerShow: 2 });
  });

  it("a sale outside the seven days is not counted", () => {
    expect(slowMovers([unit({ day: "2026-10-01", cents: 5_000, costCents: 4_000 })], week)).toEqual([]);
  });

  it("a watch with any unit uncosted has no margin to judge", () => {
    expect(slowMovers([unit({ cents: 5_000, costCents: 4_000 }), unit({ costCents: null })], week)).toEqual([]);
  });

  it("cancelled orders and unnamed random pulls are left out", () => {
    expect(slowMovers([unit({ cancelled: true, costCents: null }), unit({ model: null, costCents: null })], week)).toEqual([]);
  });

  it("thinnest margin first", () => {
    const s = slowMovers([unit({ model: "A", cents: 5_000, costCents: 4_000 }), unit({ model: "B", cents: 5_000, costCents: 4_500 })], week);
    expect(s.map((x) => x.model)).toEqual(["B", "A"]);
  });
});

describe("movements against the period before (review 10/21)", () => {
  it("a margin moves in points, not percent: 30% to 33% is +3.0 pts", () => {
    expect(marginMovement(0.33, 0.3)).toEqual({ direction: "up", label: "+3.0 pts" });
  });
  it("a margin from negative to positive is up", () => {
    expect(marginMovement(0.1, -0.05)).toEqual({ direction: "up", label: "+15.0 pts" });
  });
  it("no margin on either side says nothing", () => {
    expect(marginMovement(null, 0.3).label).toBe("—");
  });
  it("profit from a loss to a gain is up, with no misleading percent", () => {
    expect(moneyMovement(50_000, -20_000)).toEqual({ direction: "up", label: "up" });
    expect(moneyMovement(-20_000, -5_000)).toEqual({ direction: "down", label: "down" });
  });
  it("an ordinary rise is a percent", () => {
    expect(moneyMovement(12_000, 10_000)).toEqual({ direction: "up", label: "+20%" });
  });
  it("from nothing is new; nothing to nothing is a dash", () => {
    expect(moneyMovement(5_000, 0).label).toBe("new");
    expect(moneyMovement(0, 0).label).toBe("—");
  });
});

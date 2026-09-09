import { describe, expect, it } from "vitest";
import {
  change,
  formatChange,
  formatMoney,
  formatMoneyShort,
  hotThreshold,
  movingAverage,
  previousRange,
} from "./insights";

describe("comparing a period with the one before", () => {
  it("reports an ordinary rise", () => {
    const c = change(120, 100);
    expect(c.direction).toBe("up");
    expect(c.percent).toBeCloseTo(20);
    expect(formatChange(c)).toBe("+20%");
  });

  it("reports a fall", () => {
    expect(formatChange(change(80, 100))).toBe("−20%");
  });

  it("does not call going from nothing a percentage", () => {
    // "Infinity per cent up" is not a fact about the business.
    const c = change(500, 0);
    expect(c.percent).toBeNull();
    expect(formatChange(c)).toBe("new");
  });

  it("says nothing happened either side rather than showing 0%", () => {
    expect(formatChange(change(0, 0))).toBe("—");
  });

  it("calls a total stop a fall, not new", () => {
    expect(change(0, 400).direction).toBe("down");
    expect(formatChange(change(0, 400))).toBe("−100%");
  });

  it("treats a hair's breadth as level", () => {
    // Otherwise every figure reads as movement and none of them mean anything.
    expect(change(10000, 10001).direction).toBe("flat");
    expect(formatChange(change(10000, 10001))).toBe("level");
  });

  it("keeps a decimal place only while it says something", () => {
    expect(formatChange(change(1034, 1000))).toBe("+3.4%");
    expect(formatChange(change(1500, 1000))).toBe("+50%");
  });
});

describe("the period before this one", () => {
  it("is the same length, immediately before", () => {
    // Same length, not "last month": 31 days against 28 makes February look
    // like a catastrophe every year.
    expect(previousRange("2026-09-01", "2026-09-30")).toEqual({
      from: "2026-08-02",
      to: "2026-08-31",
    });
  });

  it("works for a single day", () => {
    expect(previousRange("2026-09-08", "2026-09-08")).toEqual({
      from: "2026-09-07",
      to: "2026-09-07",
    });
  });

  it("works for a week", () => {
    expect(previousRange("2026-09-07", "2026-09-13")).toEqual({
      from: "2026-08-31",
      to: "2026-09-06",
    });
  });

  it("leaves no gap between the two", () => {
    const previous = previousRange("2026-09-01", "2026-09-15");
    expect(previous.to).toBe("2026-08-31");
  });
});

describe("what counts as hot", () => {
  it("marks the top tenth by units", () => {
    // 20 models; the threshold lands on the busiest couple.
    const units = [30, 25, 12, 10, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 1, 1];
    expect(hotThreshold(units)).toBe(25);
  });

  it("will not crown something that sold twice in a quiet week", () => {
    expect(hotThreshold([2, 1, 1, 1])).toBe(3);
  });

  it("moves with the catalogue rather than being a fixed number", () => {
    // A busy fortnight should not mark everything just because volumes are up.
    const busy = Array.from({ length: 50 }, (_, i) => 50 - i);
    expect(hotThreshold(busy)).toBeGreaterThan(40);
  });

  it("marks nothing when there is nothing", () => {
    expect(hotThreshold([])).toBe(Infinity);
  });
});

describe("money", () => {
  it("reads as money", () => {
    expect(formatMoney(534_00)).toBe("$534.00");
    expect(formatMoney(1_234_56)).toBe("$1,234.56");
  });

  it("drops the pennies on a headline", () => {
    expect(formatMoneyShort(1_234_56)).toBe("$1,235");
  });

  it("shortens a big one so a stat tile stays readable", () => {
    expect(formatMoneyShort(22_537_96)).toBe("$23k");
  });
});

describe("the trend line", () => {
  it("smooths a saw into something readable", () => {
    // Two shows one day and four the next says nothing except that some days
    // are busier. The bars keep the truth; this rides over them.
    const points = [
      { dateISO: "2026-09-01", value: 0 },
      { dateISO: "2026-09-02", value: 100 },
      { dateISO: "2026-09-03", value: 0 },
      { dateISO: "2026-09-04", value: 100 },
    ];
    const smoothed = movingAverage(points, 2);
    expect(smoothed.map((p) => p.value)).toEqual([0, 50, 50, 50]);
  });

  it("keeps the dates it was given", () => {
    const points = [{ dateISO: "2026-09-01", value: 5 }];
    expect(movingAverage(points, 3)[0].dateISO).toBe("2026-09-01");
  });

  it("changes nothing with a window of one", () => {
    const points = [{ dateISO: "2026-09-01", value: 5 }, { dateISO: "2026-09-02", value: 9 }];
    expect(movingAverage(points, 1)).toEqual(points);
  });
});

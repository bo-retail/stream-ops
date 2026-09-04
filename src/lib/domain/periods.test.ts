import { describe, expect, it } from "vitest";
import {
  formatPeriod,
  formatPeriodShort,
  isPeriodStart,
  lastDayOfMonth,
  nextPeriod,
  periodDates,
  periodFor,
  periodHalf,
  periodLength,
  periodStart,
  previousPeriod,
  recentPeriods,
  upcomingPeriods,
} from "./periods";

describe("which period a date falls in", () => {
  it("puts the 1st to the 15th in the first half", () => {
    for (const day of ["01", "02", "09", "14", "15"]) {
      expect(periodFor(`2026-09-${day}`)).toEqual({ start: "2026-09-01", end: "2026-09-15" });
    }
  });

  it("puts the 16th onwards in the second half", () => {
    for (const day of ["16", "17", "25", "30"]) {
      expect(periodFor(`2026-09-${day}`)).toEqual({ start: "2026-09-16", end: "2026-09-30" });
    }
  });

  it("ends the second half on the real last day of the month", () => {
    expect(periodFor("2026-01-20").end).toBe("2026-01-31");
    expect(periodFor("2026-04-20").end).toBe("2026-04-30");
    expect(periodFor("2026-02-20").end).toBe("2026-02-28");
  });

  it("handles February in a leap year", () => {
    expect(periodFor("2028-02-20")).toEqual({ start: "2028-02-16", end: "2028-02-29" });
    expect(lastDayOfMonth(2028, 2)).toBe(29);
    expect(lastDayOfMonth(2026, 2)).toBe(28);
  });

  it("treats the 15th and 16th as different periods", () => {
    expect(periodFor("2026-09-15").start).not.toBe(periodFor("2026-09-16").start);
  });
});

describe("period boundaries", () => {
  it("recognises the 1st and the 16th as starts", () => {
    expect(isPeriodStart("2026-09-01")).toBe(true);
    expect(isPeriodStart("2026-09-16")).toBe(true);
    expect(isPeriodStart("2026-09-02")).toBe(false);
    expect(isPeriodStart("2026-09-15")).toBe(false);
    expect(isPeriodStart("2026-09-30")).toBe(false);
  });

  it("normalises any date to its period start", () => {
    expect(periodStart("2026-09-09")).toBe("2026-09-01");
    expect(periodStart("2026-09-22")).toBe("2026-09-16");
    expect(periodStart("2026-09-01")).toBe("2026-09-01");
  });
});

describe("the days in a period", () => {
  it("gives 15 days for a first half", () => {
    const dates = periodDates(periodFor("2026-09-05"));
    expect(dates).toHaveLength(15);
    expect(dates[0]).toBe("2026-09-01");
    expect(dates[14]).toBe("2026-09-15");
  });

  it("gives the right length for each second half", () => {
    expect(periodLength(periodFor("2026-01-20"))).toBe(16); // 16–31
    expect(periodLength(periodFor("2026-04-20"))).toBe(15); // 16–30
    expect(periodLength(periodFor("2026-02-20"))).toBe(13); // 16–28
    expect(periodLength(periodFor("2028-02-20"))).toBe(14); // 16–29, leap
  });

  it("runs consecutively with no gaps or repeats", () => {
    const dates = periodDates(periodFor("2026-02-20"));
    for (let i = 1; i < dates.length; i++) {
      const previous = new Date(`${dates[i - 1]}T00:00:00Z`).getTime();
      const current = new Date(`${dates[i]}T00:00:00Z`).getTime();
      expect(current - previous).toBe(86_400_000);
    }
  });
});

describe("stepping between periods", () => {
  it("moves from the first half to the second half of the same month", () => {
    expect(nextPeriod(periodFor("2026-09-05"))).toEqual({
      start: "2026-09-16",
      end: "2026-09-30",
    });
  });

  it("moves from the second half into the next month", () => {
    expect(nextPeriod(periodFor("2026-09-20"))).toEqual({
      start: "2026-10-01",
      end: "2026-10-15",
    });
  });

  it("crosses a year boundary", () => {
    expect(nextPeriod(periodFor("2026-12-20"))).toEqual({
      start: "2027-01-01",
      end: "2027-01-15",
    });
    expect(previousPeriod(periodFor("2027-01-05"))).toEqual({
      start: "2026-12-16",
      end: "2026-12-31",
    });
  });

  it("round-trips forward and back", () => {
    for (const date of ["2026-02-03", "2026-02-20", "2026-12-31", "2028-02-29"]) {
      const period = periodFor(date);
      expect(previousPeriod(nextPeriod(period))).toEqual(period);
    }
  });

  it("leaves no day uncovered between consecutive periods", () => {
    const period = periodFor("2026-02-20");
    const next = nextPeriod(period);
    const dayAfterEnd = new Date(`${period.end}T00:00:00Z`);
    dayAfterEnd.setUTCDate(dayAfterEnd.getUTCDate() + 1);
    expect(next.start).toBe(dayAfterEnd.toISOString().slice(0, 10));
  });
});

describe("listing periods", () => {
  it("lists upcoming periods in order", () => {
    const periods = upcomingPeriods("2026-09-05", 4);
    expect(periods.map((p) => p.start)).toEqual([
      "2026-09-01",
      "2026-09-16",
      "2026-10-01",
      "2026-10-16",
    ]);
  });

  it("lists recent periods newest first", () => {
    const periods = recentPeriods("2026-09-20", 3);
    expect(periods.map((p) => p.start)).toEqual(["2026-09-16", "2026-09-01", "2026-08-16"]);
  });

  it("returns nothing when none are asked for", () => {
    expect(upcomingPeriods("2026-09-05", 0)).toEqual([]);
    expect(recentPeriods("2026-09-05", 0)).toEqual([]);
  });
});

describe("naming a period", () => {
  it("reads as a date range", () => {
    expect(formatPeriod(periodFor("2026-09-05"))).toBe("1–15 September 2026");
    expect(formatPeriod(periodFor("2026-09-20"))).toBe("16–30 September 2026");
    expect(formatPeriod(periodFor("2026-02-20"))).toBe("16–28 February 2026");
  });

  it("has a short form for tabs", () => {
    expect(formatPeriodShort(periodFor("2026-09-05"))).toBe("Sep 1–15");
    expect(formatPeriodShort(periodFor("2026-12-20"))).toBe("Dec 16–31");
  });

  it("names which half", () => {
    expect(periodHalf(periodFor("2026-09-05"))).toBe("First half");
    expect(periodHalf(periodFor("2026-09-20"))).toBe("Second half");
  });
});

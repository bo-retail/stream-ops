import { describe, expect, it } from "vitest";
import {
  addDays,
  dayOfWeek,
  diffDays,
  formatDateRange,
  formatTimeHM,
  fromDbDate,
  instantsOverlap,
  resolveSlotInstants,
  toDbDate,
  todayISO,
  weekDates,
  weekStart,
} from "./dates";

const TZ = "America/New_York";

describe("date-only round tripping", () => {
  it("survives a trip through the database representation", () => {
    for (const d of ["2026-01-01", "2026-08-16", "2026-12-31", "2024-02-29"]) {
      expect(fromDbDate(toDbDate(d))).toBe(d);
    }
  });

  it("rejects malformed dates instead of coercing them", () => {
    expect(() => toDbDate("2026-8-16")).toThrow();
    expect(() => toDbDate("16/08/2026")).toThrow();
    expect(() => toDbDate("2026-13-01")).toThrow();
  });
});

describe("day arithmetic", () => {
  it("adds and subtracts days across month and year boundaries", () => {
    expect(addDays("2026-08-16", 1)).toBe("2026-08-17");
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("does not shift a day when crossing a DST boundary", () => {
    // 2026 US DST: forward Mar 8, back Nov 1. Date-only math must ignore both.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(diffDays("2026-03-01", "2026-03-31")).toBe(30);
    expect(diffDays("2026-11-01", "2026-11-30")).toBe(29);
  });

  it("measures signed day differences", () => {
    expect(diffDays("2026-08-16", "2026-08-16")).toBe(0);
    expect(diffDays("2026-08-16", "2026-08-20")).toBe(4);
    expect(diffDays("2026-08-20", "2026-08-16")).toBe(-4);
  });
});

describe("weeks", () => {
  it("anchors weeks on Monday", () => {
    expect(dayOfWeek("2026-08-16")).toBe(0); // Sunday
    expect(weekStart("2026-08-16")).toBe("2026-08-10"); // previous Monday
    expect(weekStart("2026-08-10")).toBe("2026-08-10"); // Monday is its own start
    expect(weekStart("2026-08-11")).toBe("2026-08-10");
    expect(weekStart("2026-08-15")).toBe("2026-08-10"); // Saturday
  });

  it("always returns a Monday", () => {
    for (let i = 0; i < 40; i++) {
      expect(dayOfWeek(weekStart(addDays("2026-01-01", i)))).toBe(1);
    }
  });

  it("lists seven consecutive dates", () => {
    expect(weekDates("2026-08-10")).toEqual([
      "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13",
      "2026-08-14", "2026-08-15", "2026-08-16",
    ]);
  });
});

describe("resolveSlotInstants", () => {
  it("computes a normal four-hour show", () => {
    const r = resolveSlotInstants("2026-08-12", "11:00", "15:00", TZ);
    expect(r.hoursHundredths).toBe(400);
    expect(r.crossesMidnight).toBe(false);
    expect(r.startsAt.toISOString()).toBe("2026-08-12T15:00:00.000Z"); // EDT = UTC-4
    expect(r.endsAt.toISOString()).toBe("2026-08-12T19:00:00.000Z");
  });

  it("handles a show that runs past midnight", () => {
    const r = resolveSlotInstants("2026-08-12", "22:00", "02:00", TZ);
    expect(r.crossesMidnight).toBe(true);
    expect(r.hoursHundredths).toBe(400);
    expect(r.endsAt.toISOString()).toBe("2026-08-13T06:00:00.000Z");
  });

  it("treats equal start and end times as a full day, not a zero-length show", () => {
    const r = resolveSlotInstants("2026-08-12", "12:00", "12:00", TZ);
    expect(r.crossesMidnight).toBe(true);
    expect(r.hoursHundredths).toBe(2400);
  });

  it("pays actual elapsed time when the clocks go forward", () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT, so midnight-to-4am is really 3 hours.
    const r = resolveSlotInstants("2026-03-08", "00:00", "04:00", TZ);
    expect(r.hoursHundredths).toBe(300);
  });

  it("pays actual elapsed time when the clocks go back", () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST, so midnight-to-4am is really 5 hours.
    const r = resolveSlotInstants("2026-11-01", "00:00", "04:00", TZ);
    expect(r.hoursHundredths).toBe(500);
  });

  it("respects the winter/summer offset difference", () => {
    expect(resolveSlotInstants("2026-01-12", "11:00", "15:00", TZ).startsAt.toISOString()).toBe(
      "2026-01-12T16:00:00.000Z", // EST = UTC-5
    );
  });

  it("rejects invalid times", () => {
    expect(() => resolveSlotInstants("2026-08-12", "25:00", "15:00", TZ)).toThrow();
    expect(() => resolveSlotInstants("2026-08-12", "11:60", "15:00", TZ)).toThrow();
    expect(() => resolveSlotInstants("2026-08-12", "11am", "3pm", TZ)).toThrow();
  });
});

describe("instantsOverlap", () => {
  const at = (iso: string) => new Date(iso);

  it("detects overlapping windows", () => {
    expect(
      instantsOverlap(
        at("2026-08-12T15:00:00Z"), at("2026-08-12T19:00:00Z"),
        at("2026-08-12T15:00:00Z"), at("2026-08-12T19:00:00Z"),
      ),
    ).toBe(true);
    expect(
      instantsOverlap(
        at("2026-08-12T15:00:00Z"), at("2026-08-12T19:00:00Z"),
        at("2026-08-12T18:00:00Z"), at("2026-08-12T22:00:00Z"),
      ),
    ).toBe(true);
  });

  it("treats back-to-back shows as non-overlapping", () => {
    expect(
      instantsOverlap(
        at("2026-08-12T15:00:00Z"), at("2026-08-12T19:00:00Z"),
        at("2026-08-12T19:00:00Z"), at("2026-08-12T23:00:00Z"),
      ),
    ).toBe(false);
  });

  it("treats separate days as non-overlapping", () => {
    expect(
      instantsOverlap(
        at("2026-08-12T15:00:00Z"), at("2026-08-12T19:00:00Z"),
        at("2026-08-13T15:00:00Z"), at("2026-08-13T19:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("presentation helpers", () => {
  it("formats times in 12-hour form", () => {
    expect(formatTimeHM("11:00")).toBe("11:00 AM");
    expect(formatTimeHM("19:00")).toBe("7:00 PM");
    expect(formatTimeHM("00:30")).toBe("12:30 AM");
    expect(formatTimeHM("12:00")).toBe("12:00 PM");
  });

  it("formats a date range", () => {
    expect(formatDateRange("2026-08-03", "2026-08-16")).toBe("Aug 3 – Aug 16, 2026");
    expect(formatDateRange("2025-12-29", "2026-01-11")).toBe("Dec 29, 2025 – Jan 11, 2026");
  });

  it("resolves today in the business zone, not the server zone", () => {
    // 03:00 UTC on the 17th is still the 16th in New York.
    expect(todayISO(TZ, new Date("2026-08-17T03:00:00Z"))).toBe("2026-08-16");
    expect(todayISO(TZ, new Date("2026-08-17T13:00:00Z"))).toBe("2026-08-17");
  });
});

import { describe, expect, it } from "vitest";
import { paidWindow, showClampsPay, showForClockIn } from "./hours";
import type { ShiftWindow } from "./hours";

/** A 13:00–19:00 show on 2026-09-03, in UTC for readability. */
const shift: ShiftWindow = {
  startsAt: new Date("2026-09-03T13:00:00Z"),
  endsAt: new Date("2026-09-03T19:00:00Z"),
};

const at = (time: string) => new Date(`2026-09-03T${time}:00Z`);

describe("clocking in", () => {
  it("counts from the shift start when somebody arrives early", () => {
    const paid = paidWindow({ clockInAt: at("12:40"), clockOutAt: at("19:00") }, shift);
    expect(paid.from).toEqual(shift.startsAt);
    expect(paid.minutes).toBe(360); // the full six hours, not 6h20
    expect(paid.lateMinutes).toBe(0);
    expect(paid.unpaidMinutes).toBe(20);
  });

  it("counts from the clock-in when somebody is late", () => {
    const paid = paidWindow({ clockInAt: at("13:25"), clockOutAt: at("19:00") }, shift);
    expect(paid.from).toEqual(at("13:25"));
    expect(paid.minutes).toBe(335); // six hours less the 25 minutes
    expect(paid.lateMinutes).toBe(25);
  });

  it("treats clocking in exactly on time as neither early nor late", () => {
    const paid = paidWindow({ clockInAt: at("13:00"), clockOutAt: at("19:00") }, shift);
    expect(paid.minutes).toBe(360);
    expect(paid.lateMinutes).toBe(0);
    expect(paid.unpaidMinutes).toBe(0);
  });
});

describe("clocking out", () => {
  it("counts to the clock-out when somebody leaves early", () => {
    const paid = paidWindow({ clockInAt: at("13:00"), clockOutAt: at("18:30") }, shift);
    expect(paid.to).toEqual(at("18:30"));
    expect(paid.minutes).toBe(330);
    expect(paid.leftEarlyMinutes).toBe(30);
  });

  it("counts to the shift end when somebody stays late", () => {
    const paid = paidWindow({ clockInAt: at("13:00"), clockOutAt: at("19:45") }, shift);
    expect(paid.to).toEqual(shift.endsAt);
    expect(paid.minutes).toBe(360); // not 6h45
    expect(paid.leftEarlyMinutes).toBe(0);
    expect(paid.unpaidMinutes).toBe(45);
  });

  it("treats clocking out exactly on time as neither", () => {
    const paid = paidWindow({ clockInAt: at("13:00"), clockOutAt: at("19:00") }, shift);
    expect(paid.leftEarlyMinutes).toBe(0);
    expect(paid.unpaidMinutes).toBe(0);
  });
});

describe("both ends at once", () => {
  it("pays only the shift when somebody is early and stays late", () => {
    const paid = paidWindow({ clockInAt: at("12:30"), clockOutAt: at("20:00") }, shift);
    expect(paid.from).toEqual(shift.startsAt);
    expect(paid.to).toEqual(shift.endsAt);
    expect(paid.minutes).toBe(360);
    expect(paid.unpaidMinutes).toBe(90);
    expect(paid.clamped).toBe(true);
  });

  it("pays only what was worked when somebody is late and leaves early", () => {
    const paid = paidWindow({ clockInAt: at("14:00"), clockOutAt: at("18:00") }, shift);
    expect(paid.minutes).toBe(240);
    expect(paid.lateMinutes).toBe(60);
    expect(paid.leftEarlyMinutes).toBe(60);
    expect(paid.clamped).toBe(false); // the clock bounded it, not the shift
  });
});

describe("no overlap at all", () => {
  it("pays nothing when somebody clocks in after the show ended", () => {
    const paid = paidWindow({ clockInAt: at("20:00"), clockOutAt: at("21:00") }, shift);
    expect(paid.minutes).toBe(0);
  });

  it("pays nothing when somebody clocks out before the show started", () => {
    const paid = paidWindow({ clockInAt: at("10:00"), clockOutAt: at("11:00") }, shift);
    expect(paid.minutes).toBe(0);
  });

  it("never reports a negative duration", () => {
    for (const [inAt, outAt] of [
      ["20:00", "21:00"],
      ["10:00", "11:00"],
      ["19:00", "19:30"],
    ] as const) {
      const paid = paidWindow({ clockInAt: at(inAt), clockOutAt: at(outAt) }, shift);
      expect(paid.minutes).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("still clocked in", () => {
  it("reports no minutes yet", () => {
    const paid = paidWindow({ clockInAt: at("13:00"), clockOutAt: null }, shift);
    expect(paid.to).toBeNull();
    expect(paid.minutes).toBeNull();
  });

  it("still records lateness", () => {
    const paid = paidWindow({ clockInAt: at("13:30"), clockOutAt: null }, shift);
    expect(paid.lateMinutes).toBe(30);
  });
});

describe("no shift to measure against", () => {
  it("pays the raw times exactly, for shipping", () => {
    const paid = paidWindow({ clockInAt: at("09:00"), clockOutAt: at("17:30") }, null);
    expect(paid.from).toEqual(at("09:00"));
    expect(paid.to).toEqual(at("17:30"));
    expect(paid.minutes).toBe(510);
    expect(paid.clamped).toBe(false);
    expect(paid.unpaidMinutes).toBe(0);
  });

  it("does not zero a streamer who clocked in outside any show", () => {
    // Silently paying nothing would hide the problem. It is left for the boss.
    const paid = paidWindow({ clockInAt: at("02:00"), clockOutAt: at("05:00") }, null);
    expect(paid.minutes).toBe(180);
  });

  it("handles an open entry", () => {
    const paid = paidWindow({ clockInAt: at("09:00"), clockOutAt: null }, null);
    expect(paid.minutes).toBeNull();
  });
});

describe("a night show running past midnight", () => {
  const night: ShiftWindow = {
    startsAt: new Date("2026-09-03T19:00:00Z"),
    endsAt: new Date("2026-09-04T01:00:00Z"),
  };

  it("pays the whole shift when clocked accurately", () => {
    const paid = paidWindow(
      {
        clockInAt: new Date("2026-09-03T19:00:00Z"),
        clockOutAt: new Date("2026-09-04T01:00:00Z"),
      },
      night,
    );
    expect(paid.minutes).toBe(360);
  });

  it("clamps a clock-out after midnight to the shift end", () => {
    const paid = paidWindow(
      {
        clockInAt: new Date("2026-09-03T18:50:00Z"),
        clockOutAt: new Date("2026-09-04T01:40:00Z"),
      },
      night,
    );
    expect(paid.minutes).toBe(360);
    expect(paid.unpaidMinutes).toBe(50);
  });
});

/* ------------------------------------------------- picking the right show */

describe("which show a clock-in belongs to", () => {
  const day: ShiftWindow = { startsAt: at("13:00"), endsAt: at("19:00") };
  const night: ShiftWindow = {
    startsAt: at("19:00"),
    endsAt: new Date("2026-09-04T01:00:00Z"),
  };

  it("picks the show that is running", () => {
    expect(showForClockIn(at("14:00"), [day, night])).toBe(day);
    expect(showForClockIn(at("21:00"), [day, night])).toBe(night);
  });

  it("picks the show about to start when somebody is early", () => {
    expect(showForClockIn(at("12:45"), [day, night])).toBe(day);
    expect(showForClockIn(at("18:50"), [day, night])).toBe(day); // still inside the day show
  });

  it("prefers the nearer show when two are close", () => {
    // 19:05 is inside the night show, so it wins over the day show that just ended.
    expect(showForClockIn(at("19:05"), [day, night])).toBe(night);
  });

  it("returns nothing when no show is anywhere near", () => {
    expect(showForClockIn(at("04:00"), [day, night])).toBeNull();
  });

  it("returns nothing when the person has no shows", () => {
    expect(showForClockIn(at("14:00"), [])).toBeNull();
  });

  it("respects the window it is given", () => {
    // 09:00 is four hours before the day show.
    expect(showForClockIn(at("09:00"), [day], 6)).toBe(day);
    expect(showForClockIn(at("09:00"), [day], 2)).toBeNull();
  });

  it("does not reach into a show a long way past", () => {
    const yesterday: ShiftWindow = {
      startsAt: new Date("2026-09-02T13:00:00Z"),
      endsAt: new Date("2026-09-02T19:00:00Z"),
    };
    expect(showForClockIn(at("13:00"), [yesterday])).toBeNull();
  });
});

describe("what bounds an entry's pay", () => {
  /*
    Separate from "which show was this entry against", which is answered by
    whether there is one at all. The two were once the same expression, and the
    result was that every schedule-printed row on the Payroll screen read "No
    scheduled show" — the one case where the show is certain. These tests exist
    so the pay rule keeps its own answer when somebody next tidies the label.
  */

  it("clamps a self-clocked entry to its show", () => {
    // The only case that asks "they turned up twenty minutes early, do we pay
    // it" — because it is the only one where somebody pressed a button.
    expect(showClampsPay("SELF", "SCHEDULED")).toBe(true);
  });

  it("does not clamp hours printed from the schedule", () => {
    // Those times *are* the shift, so clamping is a no-op until the boss
    // corrects one, at which point it would quietly undo the correction.
    expect(showClampsPay("SCHEDULE", "SCHEDULED")).toBe(false);
  });

  it("does not clamp an admin's entry", () => {
    // Somebody typed those hours deliberately, with a reason.
    expect(showClampsPay("ADMIN", "SCHEDULED")).toBe(false);
  });

  it("stops clamping once the show is cancelled", () => {
    // A cancelled show is not a shift anybody was meant to work, so whatever
    // they actually clocked stands.
    expect(showClampsPay("SELF", "CANCELLED")).toBe(false);
  });

  it("does not clamp an entry with no show at all", () => {
    // Shipping, and any streamer who clocked in when they were on nothing.
    expect(showClampsPay("SELF", null)).toBe(false);
    expect(showClampsPay("SCHEDULE", null)).toBe(false);
  });
});

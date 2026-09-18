import { describe, expect, it } from "vitest";
import { checkCandidate, planCopyForward, validateSchedule } from "./schedule";
import type {
  AssignmentInput,
  AvailabilityInput,
  BookedElsewhere,
  CopySourceShow,
  CopyTargetShow,
  ShowInput,
} from "./schedule";
import type { Slot } from "./types";

const DATE = "2026-08-21";

/** Wall-clock hour on DATE in the business zone (EDT = UTC-4). */
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 21, h + 4, m));
/** The same, on the following day — for a night show running past midnight. */
const nextDay = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 22, h + 4, m));

let seq = 0;

function show(over: Partial<ShowInput> = {}): ShowInput {
  const slot: Slot = over.slot ?? "DAY";
  return {
    id: `show${seq++}`,
    dateISO: DATE,
    platform: "TIKTOK",
    slot,
    // Day 13:00–19:00, night 19:00–01:00 the next day.
    startsAt: slot === "DAY" ? at(13) : at(19),
    endsAt: slot === "DAY" ? at(19) : nextDay(1),
    status: "SCHEDULED",
    ...over,
  };
}

/** Both people on a show. */
function staff(showInput: ShowInput, first: string, second: string): AssignmentInput[] {
  return [one(showInput, first, 1), one(showInput, second, 2)];
}

function one(showInput: ShowInput, userId: string, seat: number): AssignmentInput {
  return { id: `a${seq++}`, showId: showInput.id, userId, userName: userId, seat };
}

const codes = (result: ReturnType<typeof validateSchedule>) => result.issues.map((i) => i.code);

describe("staffing a show", () => {
  it("is happy with two people", () => {
    const s = show();
    const result = validateSchedule([s], staff(s, "maya", "devon"));
    expect(result.errors).toEqual([]);
    expect(result.canPublish).toBe(true);
    expect(result.filledSeats).toBe(2);
    expect(result.totalSeats).toBe(2);
  });

  it("does not care which seat is which", () => {
    // The pair swap jobs halfway, so seat 1 and seat 2 are interchangeable.
    const s = show();
    const forwards = validateSchedule([s], staff(s, "maya", "devon"));
    const swapped = validateSchedule([s], staff(s, "devon", "maya"));
    expect(swapped.errors).toEqual(forwards.errors);
    expect(swapped.filledSeats).toBe(forwards.filledSeats);
  });

  it("warns but still publishes when only one person is on", () => {
    const s = show();
    const result = validateSchedule([s], [one(s, "maya", 1)]);
    expect(codes(result)).toContain("UNSTAFFED");
    expect(result.warnings[0].message).toContain("only one person");
    // An open seat is filled by talking to people, not by blocking the publish.
    expect(result.errors).toEqual([]);
    expect(result.canPublish).toBe(true);
    expect(result.openSeats).toBe(1);
  });

  it("says so plainly when a show is empty, and still publishes", () => {
    const s = show();
    const result = validateSchedule([s], []);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toContain("nobody on it");
    expect(result.shows[0].empty).toBe(2);
    expect(result.canPublish).toBe(true);
    expect(result.openSeats).toBe(2);
  });

  it("will not publish a release with no shows at all", () => {
    expect(validateSchedule([], []).canPublish).toBe(false);
  });
});

describe("cancelled shows", () => {
  it("needs nobody", () => {
    const s = show({ status: "CANCELLED" });
    const result = validateSchedule([s], []);
    expect(result.errors).toEqual([]);
    expect(result.canPublish).toBe(true);
  });

  it("is left out of the seat count", () => {
    const live = show();
    const off = show({ slot: "NIGHT", status: "CANCELLED" });
    const result = validateSchedule([live, off], staff(live, "maya", "devon"));
    expect(result.totalSeats).toBe(2);
    expect(result.filledSeats).toBe(2);
  });

  it("frees the people who were on it", () => {
    // Same hours on both platforms — normally a clash.
    const tiktok = show({ platform: "TIKTOK" });
    const ebay = show({ platform: "EBAY", status: "CANCELLED" });
    const result = validateSchedule(
      [tiktok, ebay],
      [...staff(tiktok, "maya", "devon"), one(ebay, "maya", 1)],
    );
    expect(codes(result)).not.toContain("DOUBLE_BOOKED");
  });
});

describe("double booking", () => {
  it("catches the same person on two platforms at once", () => {
    const tiktok = show({ platform: "TIKTOK" });
    const ebay = show({ platform: "EBAY" });
    const result = validateSchedule(
      [tiktok, ebay],
      [...staff(tiktok, "maya", "devon"), ...staff(ebay, "maya", "erin")],
    );
    const clash = result.issues.find((i) => i.code === "DOUBLE_BOOKED");
    expect(clash?.severity).toBe("error");
    expect(clash?.message).toContain("maya");
    expect(result.canPublish).toBe(false);
  });

  it("allows a day show followed by that evening's night show", () => {
    // Day ends 19:00, night starts 19:00 — a handover, not a clash.
    const day = show({ slot: "DAY" });
    const night = show({ slot: "NIGHT" });
    const result = validateSchedule(
      [day, night],
      [...staff(day, "maya", "devon"), ...staff(night, "maya", "devon")],
    );
    expect(codes(result)).not.toContain("DOUBLE_BOOKED");
  });

  it("allows the same pair on the same slot on different days", () => {
    const monday = show({ dateISO: DATE });
    const tuesday = show({
      dateISO: "2026-08-22",
      startsAt: nextDay(13),
      endsAt: nextDay(19),
    });
    const result = validateSchedule(
      [monday, tuesday],
      [...staff(monday, "maya", "devon"), ...staff(tuesday, "maya", "devon")],
    );
    expect(codes(result)).not.toContain("DOUBLE_BOOKED");
  });

  it("catches a night show overlapping the next morning", () => {
    const night = show({ slot: "NIGHT" });
    const early = show({
      dateISO: "2026-08-22",
      platform: "EBAY",
      startsAt: nextDay(0),
      endsAt: nextDay(6),
    });
    const result = validateSchedule(
      [night, early],
      [...staff(night, "maya", "devon"), ...staff(early, "maya", "erin")],
    );
    expect(codes(result)).toContain("DOUBLE_BOOKED");
  });

  it("reports one person's clash once, not once per show", () => {
    const tiktok = show({ platform: "TIKTOK" });
    const ebay = show({ platform: "EBAY" });
    const result = validateSchedule(
      [tiktok, ebay],
      [...staff(tiktok, "maya", "devon"), ...staff(ebay, "maya", "erin")],
    );
    expect(result.issues.filter((i) => i.code === "DOUBLE_BOOKED")).toHaveLength(1);
  });

  it("does not report somebody twice on one show as a clash with itself", () => {
    // The database forbids this, but the validator must not produce the
    // nonsense "on X and X at the same time" if it ever sees it.
    const s = show();
    const result = validateSchedule([s], [one(s, "maya", 1), one(s, "maya", 2)]);
    expect(codes(result)).not.toContain("DOUBLE_BOOKED");
  });
});

describe("availability", () => {
  const offered = (userId: string, slot: Slot): AvailabilityInput => ({
    userId,
    dateISO: DATE,
    slot,
  });

  it("is satisfied when both people offered that show", () => {
    const s = show({ slot: "DAY" });
    const result = validateSchedule([s], staff(s, "maya", "devon"), {
      availability: [offered("maya", "DAY"), offered("devon", "DAY")],
    });
    expect(result.warnings).toEqual([]);
  });

  it("warns when someone is put on a show they did not offer", () => {
    const s = show({ slot: "NIGHT" });
    const result = validateSchedule([s], staff(s, "maya", "devon"), {
      availability: [offered("maya", "DAY"), offered("devon", "NIGHT")],
    });
    const issue = result.issues.find((i) => i.code === "NOT_AVAILABLE");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("maya");
    // A warning must never block the boss from publishing.
    expect(result.canPublish).toBe(true);
  });

  it("does not nag about someone who has not submitted at all", () => {
    // Otherwise a person who never submitted generates a warning per show,
    // burying the one warning that matters: that they have not submitted.
    const s = show();
    const result = validateSchedule([s], staff(s, "maya", "devon"), {
      availability: [offered("devon", "DAY")],
    });
    expect(codes(result)).not.toContain("NOT_AVAILABLE");
  });

  it("warns once when people have not sent availability in", () => {
    const s = show();
    const result = validateSchedule([s], staff(s, "maya", "devon"), {
      expectedUserIds: ["maya", "devon", "erin"],
      submittedUserIds: ["maya"],
    });
    const issue = result.issues.find((i) => i.code === "MISSING_SUBMISSION");
    expect(issue?.message).toContain("2 people");
  });

  it("says nothing when everyone has submitted", () => {
    const s = show();
    const result = validateSchedule([s], staff(s, "maya", "devon"), {
      expectedUserIds: ["maya", "devon"],
      submittedUserIds: ["maya", "devon"],
    });
    expect(codes(result)).not.toContain("MISSING_SUBMISSION");
  });
});

describe("time off", () => {
  it("warns when someone is scheduled on a day they booked off", () => {
    const s = show();
    const result = validateSchedule([s], staff(s, "maya", "devon"), {
      timeOffByUser: { maya: [DATE] },
    });
    const issue = result.issues.find((i) => i.code === "ON_TIME_OFF");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("maya");
  });

  it("ignores days off that are not this one", () => {
    const s = show();
    const result = validateSchedule([s], staff(s, "maya", "devon"), {
      timeOffByUser: { maya: ["2026-08-25"] },
    });
    expect(codes(result)).not.toContain("ON_TIME_OFF");
  });
});

describe("weekly limit", () => {
  it("warns above the cap", () => {
    const shows = [show(), show({ platform: "EBAY", slot: "NIGHT" })];
    const assignments = [one(shows[0], "maya", 1), one(shows[1], "maya", 1)];
    const result = validateSchedule(shows, assignments, { maxShowsPerPerson: 1 });
    const issue = result.issues.find((i) => i.code === "OVER_MAX_SHOWS");
    expect(issue?.message).toContain("2 shows");
  });

  it("is silent at the cap", () => {
    const s = show();
    const result = validateSchedule([s], staff(s, "maya", "devon"), { maxShowsPerPerson: 1 });
    expect(codes(result)).not.toContain("OVER_MAX_SHOWS");
  });

  it("is skipped when no cap is set", () => {
    const shows = [show(), show({ platform: "EBAY", slot: "NIGHT" })];
    const assignments = [one(shows[0], "maya", 1), one(shows[1], "maya", 1)];
    for (const cap of [null, undefined, 0]) {
      const result = validateSchedule(shows, assignments, { maxShowsPerPerson: cap });
      expect(codes(result)).not.toContain("OVER_MAX_SHOWS");
    }
  });

  it("counts shows per person", () => {
    const shows = [show(), show({ platform: "EBAY" })];
    const result = validateSchedule(shows, [
      ...staff(shows[0], "maya", "devon"),
      one(shows[1], "devon", 1),
    ]);
    expect(result.showsByUser).toEqual({ maya: 1, devon: 2 });
  });
});

describe("picking someone for a show", () => {
  it("allows a free person", () => {
    const s = show();
    expect(checkCandidate("maya", s, { assignments: [], shows: [s] })).toEqual({ ok: true });
  });

  it("refuses someone already on an overlapping show", () => {
    const tiktok = show({ platform: "TIKTOK" });
    const ebay = show({ platform: "EBAY" });
    const result = checkCandidate("maya", ebay, {
      assignments: [one(tiktok, "maya", 1)],
      shows: [tiktok, ebay],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Already on");
  });

  it("refuses somebody already on this show", () => {
    // A show needs two different people.
    const s = show();
    const result = checkCandidate("maya", s, {
      assignments: [one(s, "maya", 1)],
      shows: [s],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Already on this show");
  });

  it("allows someone whose other show is cancelled", () => {
    const tiktok = show({ platform: "TIKTOK", status: "CANCELLED" });
    const ebay = show({ platform: "EBAY" });
    const result = checkCandidate("maya", ebay, {
      assignments: [one(tiktok, "maya", 1)],
      shows: [tiktok, ebay],
    });
    expect(result.ok).toBe(true);
  });

  it("allows but flags someone who booked the day off", () => {
    const s = show();
    const result = checkCandidate("maya", s, {
      assignments: [],
      shows: [s],
      timeOffByUser: { maya: [DATE] },
    });
    expect(result.ok).toBe(true);
    expect(result.severity).toBe("warning");
    expect(result.reason).toContain("off");
  });

  it("allows but flags someone who did not offer the show", () => {
    const s = show({ slot: "NIGHT" });
    const result = checkCandidate("maya", s, {
      assignments: [],
      shows: [s],
      availability: [{ userId: "maya", dateISO: DATE, slot: "DAY" }],
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toContain("Did not offer");
  });

  it("says nothing about someone who never submitted", () => {
    const s = show();
    const result = checkCandidate("maya", s, {
      assignments: [],
      shows: [s],
      availability: [{ userId: "devon", dateISO: DATE, slot: "DAY" }],
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("copying the last release forward", () => {
  // 2026-08-18 is a Tuesday; 2026-08-25 is the Tuesday after it.
  const lastTuesday = new Date(Date.UTC(2026, 7, 18));
  const thisTuesday = new Date(Date.UTC(2026, 7, 25));
  const thisWednesday = new Date(Date.UTC(2026, 7, 26));

  function source(over: Partial<CopySourceShow> = {}): CopySourceShow {
    return {
      date: lastTuesday,
      platform: "TIKTOK",
      slot: "NIGHT",
      assignments: [
        { userId: "maya", seat: 1 },
        { userId: "devon", seat: 2 },
      ],
      ...over,
    };
  }

  function target(over: Partial<CopyTargetShow> = {}): CopyTargetShow {
    return {
      id: "new1",
      date: thisTuesday,
      platform: "TIKTOK",
      slot: "NIGHT",
      takenSeats: [],
      ...over,
    };
  }

  const everyone = new Set(["maya", "devon", "ana"]);

  it("carries the same weekday, platform and slot across", () => {
    const plan = planCopyForward([source()], [target()], everyone);
    expect(plan.toCreate).toEqual([
      { showId: "new1", userId: "maya", seat: 1 },
      { showId: "new1", userId: "devon", seat: 2 },
    ]);
    expect(plan.skipped).toBe(0);
  });

  it("leaves a different weekday alone", () => {
    const plan = planCopyForward([source()], [target({ date: thisWednesday })], everyone);
    expect(plan.toCreate).toEqual([]);
  });

  it("leaves a different slot alone", () => {
    const plan = planCopyForward([source()], [target({ slot: "DAY" })], everyone);
    expect(plan.toCreate).toEqual([]);
  });

  it("never overwrites a seat already filled", () => {
    const plan = planCopyForward([source()], [target({ takenSeats: [1] })], everyone);
    expect(plan.toCreate).toEqual([{ showId: "new1", userId: "devon", seat: 2 }]);
  });

  // The bug this exists for. Somebody who has left, or moved onto shipping,
  // keeps their place on the release they actually worked — so there is always a
  // name to find — and copying it forward would put them on a rota going out.
  it("does not carry forward somebody who can no longer be scheduled", () => {
    const plan = planCopyForward([source()], [target()], new Set(["devon"]));
    expect(plan.toCreate).toEqual([{ showId: "new1", userId: "devon", seat: 2 }]);
    expect(plan.skipped).toBe(1);
  });

  it("counts every placement it dropped, so the boss can be told", () => {
    const plan = planCopyForward([source()], [target()], new Set<string>());
    expect(plan.toCreate).toEqual([]);
    expect(plan.skipped).toBe(2);
  });

  it("leaves the seat open rather than promoting the other person into it", () => {
    const plan = planCopyForward([source()], [target()], new Set(["maya"]));
    expect(plan.toCreate).toEqual([{ showId: "new1", userId: "maya", seat: 1 }]);
  });

  // A three-week release copying from a two-week one has two candidate Tuesdays.
  it("repeats the earliest match when a weekday appears twice", () => {
    const first = source({ date: lastTuesday });
    const second = source({
      date: new Date(Date.UTC(2026, 7, 11)),
      assignments: [{ userId: "ana", seat: 1 }],
    });
    const plan = planCopyForward([first, second], [target()], everyone);
    // 11 August is the earlier Tuesday, so its pattern is the one that repeats.
    expect(plan.toCreate).toEqual([{ showId: "new1", userId: "ana", seat: 1 }]);
  });

  it("never puts one person in both seats", () => {
    const both = source({
      assignments: [
        { userId: "maya", seat: 1 },
        { userId: "maya", seat: 2 },
      ],
    });
    const plan = planCopyForward([both], [target()], everyone);
    expect(plan.toCreate).toEqual([{ showId: "new1", userId: "maya", seat: 1 }]);
  });

  it("has nothing to say when there is no previous release", () => {
    expect(planCopyForward([], [target()], everyone)).toEqual({ toCreate: [], skipped: 0 });
  });
});

/*
  Shows in another release.

  A watch release and a diamond release are built on separate screens but can
  cover the same days at the same hours — on 09/15 the diamond show ran
  10:32–16:01 against the watch day show's 10:06–16:05. Each check used to see
  only its own release, so somebody on a published diamond show could be put on
  an overlapping watch show and both would publish.
*/
describe("shows in another release", () => {
  const diamondMorning: BookedElsewhere = {
    userId: "maria",
    userName: "Maria",
    label: "Diamond TikTok Day on 2026-08-21",
    startsAt: at(10, 30),
    endsAt: at(16),
  };

  it("refuses to publish somebody who is on an overlapping show elsewhere", () => {
    const watchDay = show({ slot: "DAY" }); // 13:00–19:00
    const result = validateSchedule([watchDay], [one(watchDay, "maria", 1)], {
      elsewhere: [diamondMorning],
    });
    expect(result.canPublish).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(["DOUBLE_BOOKED"]);
    expect(result.errors[0].message).toContain("Diamond TikTok Day on 2026-08-21");
  });

  it("lets them work a show that does not overlap", () => {
    const watchNight = show({ slot: "NIGHT" }); // 19:00–01:00
    const result = validateSchedule([watchNight], [one(watchNight, "maria", 1)], {
      elsewhere: [diamondMorning],
    });
    expect(result.canPublish).toBe(true);
    expect(codes(result)).not.toContain("DOUBLE_BOOKED");
  });

  it("does not count back-to-back as a clash", () => {
    const afterwards = show({ startsAt: at(16), endsAt: at(19) });
    const result = validateSchedule([afterwards], [one(afterwards, "maria", 1)], {
      elsewhere: [diamondMorning],
    });
    expect(codes(result)).not.toContain("DOUBLE_BOOKED");
  });

  it("only concerns the person who is booked elsewhere", () => {
    const watchDay = show({ slot: "DAY" });
    const result = validateSchedule([watchDay], [one(watchDay, "dani", 1)], {
      elsewhere: [diamondMorning],
    });
    expect(codes(result)).not.toContain("DOUBLE_BOOKED");
  });

  it("ignores a cancelled show here, which needs nobody", () => {
    const cancelled = show({ slot: "DAY", status: "CANCELLED" });
    const result = validateSchedule([cancelled], [one(cancelled, "maria", 1)], {
      elsewhere: [diamondMorning],
    });
    expect(codes(result)).not.toContain("DOUBLE_BOOKED");
  });

  it("catches a night show elsewhere running into the next morning", () => {
    const lateElsewhere: BookedElsewhere = { ...diamondMorning, startsAt: at(22), endsAt: nextDay(2) };
    const earlyNextDay = show({ dateISO: "2026-08-22", startsAt: nextDay(1), endsAt: nextDay(7) });
    const result = validateSchedule([earlyNextDay], [one(earlyNextDay, "maria", 1)], {
      elsewhere: [lateElsewhere],
    });
    expect(result.canPublish).toBe(false);
  });

  it("greys them out in the picker, naming the other show", () => {
    const watchDay = show({ slot: "DAY" });
    const result = checkCandidate("maria", watchDay, {
      assignments: [],
      shows: [watchDay],
      elsewhere: [diamondMorning],
    });
    expect(result).toEqual({
      ok: false,
      reason: "Already on Diamond TikTok Day on 2026-08-21",
      severity: "error",
    });
  });

  it("leaves them pickable for a show that does not overlap", () => {
    const watchNight = show({ slot: "NIGHT" });
    const result = checkCandidate("maria", watchNight, {
      assignments: [],
      shows: [watchNight],
      elsewhere: [diamondMorning],
    });
    expect(result.ok).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { checkCandidate, validateSchedule } from "./schedule";
import type { AssignmentInput, AvailabilityInput, ShowInput } from "./schedule";
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

import { describe, expect, it } from "vitest";
import { reportsStillToCome } from "./reports-to-come";

// Pacific daylight time: 4 AM Pacific is 11:00 UTC.
const at = (iso: string) => new Date(iso);
const show = (date: string, slot: string, startsAt: string) => ({ date, slot, startsAt: at(startsAt) });

/** 10/20 had an early, a day and a night show; 10/21 the same. */
const SHOWS = [
  show("2026-10-20", "EARLY AM", "2026-10-20T11:00:00Z"),
  show("2026-10-20", "DAY", "2026-10-20T17:00:00Z"),
  show("2026-10-20", "NIGHT", "2026-10-20T23:00:00Z"),
  show("2026-10-21", "EARLY AM", "2026-10-21T11:00:00Z"),
  show("2026-10-21", "DAY", "2026-10-21T17:00:00Z"),
  show("2026-10-21", "NIGHT", "2026-10-21T23:00:00Z"),
];
const ALL_OF_1020 = new Set(["2026-10-20|EARLY AM", "2026-10-20|DAY", "2026-10-20|NIGHT"]);
// The 10/20 files went up at 8:50 AM Eastern on 10/21.
const MORNING = at("2026-10-21T12:50:00Z");

describe("reportsStillToCome", () => {
  it("10/21: a 10/20 box waits for the 10/21 early show, which was live before the labels", () => {
    expect(
      reportsStillToCome({ boxDay: "2026-10-20", firstSeenAt: MORNING, shows: SHOWS, uploadedSlots: ALL_OF_1020 }),
    ).toEqual([{ date: "2026-10-21", slot: "EARLY AM" }]);
  });

  it("nothing once that report is in", () => {
    expect(
      reportsStillToCome({
        boxDay: "2026-10-20",
        firstSeenAt: MORNING,
        shows: SHOWS,
        uploadedSlots: new Set([...ALL_OF_1020, "2026-10-21|EARLY AM"]),
      }),
    ).toEqual([]);
  });

  it("a show of the box's own day not uploaded yet: the second file uploaded later", () => {
    expect(
      reportsStillToCome({
        boxDay: "2026-10-20",
        firstSeenAt: MORNING,
        shows: SHOWS.filter((s) => s.date === "2026-10-20"),
        uploadedSlots: new Set(["2026-10-20|EARLY AM", "2026-10-20|DAY"]),
      }),
    ).toEqual([{ date: "2026-10-20", slot: "NIGHT" }]);
  });

  it("never the next day's day or night show, even when the report goes up late", () => {
    const lateAfternoon = at("2026-10-21T22:00:00Z");
    expect(
      reportsStillToCome({
        boxDay: "2026-10-20",
        firstSeenAt: lateAfternoon,
        shows: SHOWS,
        uploadedSlots: new Set([...ALL_OF_1020, "2026-10-21|EARLY AM"]),
      }),
    ).toEqual([]);
  });

  it("not a show that started after the label was first seen", () => {
    const veryEarly = at("2026-10-21T10:00:00Z"); // before the 10/21 early show began
    expect(
      reportsStillToCome({ boxDay: "2026-10-20", firstSeenAt: veryEarly, shows: SHOWS, uploadedSlots: ALL_OF_1020 }),
    ).toEqual([]);
  });

  it("a day with no early show next morning: nothing to wait for", () => {
    expect(
      reportsStillToCome({
        boxDay: "2026-10-20",
        firstSeenAt: MORNING,
        shows: SHOWS.filter((s) => s.slot !== "EARLY AM"),
        uploadedSlots: new Set(["2026-10-20|DAY", "2026-10-20|NIGHT"]),
      }),
    ).toEqual([]);
  });

  it("a day with no shows at all, and a label in no report", () => {
    expect(reportsStillToCome({ boxDay: "2026-10-20", firstSeenAt: MORNING, shows: [], uploadedSlots: new Set() })).toEqual([]);
    expect(
      reportsStillToCome({ boxDay: "2026-10-20", firstSeenAt: null, shows: SHOWS, uploadedSlots: new Set() }),
    ).toEqual([]);
  });

  it("the next day's day show called off: still never its night show (review)", () => {
    const evening = at("2026-10-21T23:30:00Z");
    expect(
      reportsStillToCome({
        boxDay: "2026-10-20",
        firstSeenAt: evening,
        shows: SHOWS.filter((s) => !(s.date === "2026-10-21" && s.slot === "DAY")),
        uploadedSlots: new Set([...ALL_OF_1020, "2026-10-21|EARLY AM"]),
      }),
    ).toEqual([]);
  });

  /*
    Known and accepted (review 10/21): a label first seen in an early-show file
    is measured from that day, so it waits for the following morning's early
    show too. On an early-show day every box waits for that morning's report
    anyway, and uploading the early show's orders so far with the morning files
    clears both.
  */
  it("a label first seen in an early-show file waits for the next early show", () => {
    expect(
      reportsStillToCome({
        boxDay: "2026-10-21",
        firstSeenAt: at("2026-10-22T12:50:00Z"),
        shows: [...SHOWS, show("2026-10-22", "EARLY AM", "2026-10-22T11:00:00Z"), show("2026-10-22", "DAY", "2026-10-22T17:00:00Z")],
        uploadedSlots: new Set([...ALL_OF_1020, "2026-10-21|EARLY AM", "2026-10-21|DAY", "2026-10-21|NIGHT"]),
      }),
    ).toEqual([{ date: "2026-10-22", slot: "EARLY AM" }]);
  });

  it("several missing, earliest first", () => {
    expect(
      reportsStillToCome({
        boxDay: "2026-10-20",
        firstSeenAt: MORNING,
        shows: SHOWS,
        uploadedSlots: new Set(["2026-10-20|EARLY AM"]),
      }),
    ).toEqual([
      { date: "2026-10-20", slot: "DAY" },
      { date: "2026-10-20", slot: "NIGHT" },
      { date: "2026-10-21", slot: "EARLY AM" },
    ]);
  });
});

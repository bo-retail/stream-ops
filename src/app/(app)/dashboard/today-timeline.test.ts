import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TodayTimeline } from "./today-timeline";
import type { TimelineShow } from "./today-timeline";

/*
  What-ifs for the dashboard's "Today" timeline, which is drawn from the same
  rows as the list under it: night shows past midnight, an early extra show,
  "now" before, inside and after the day, and a day with no shows.
*/
let n = 0;
function show(over: Partial<TimelineShow>): TimelineShow {
  return {
    id: `s${n++}`,
    business: "WATCH",
    platform: "TIKTOK",
    slot: "DAY",
    startHM: "13:00",
    endHM: "19:00",
    live: false,
    done: false,
    short: false,
    seatsMissing: 0,
    names: ["Maya", "Devon"],
    ...over,
  };
}
const render = (shows: TimelineShow[], nowHM: string) => renderToStaticMarkup(createElement(TodayTimeline, { shows, nowHM }));
const lefts = (html: string) => [...html.matchAll(/left:(-?[\d.]+)%/g)].map((m) => Number(m[1]));
const handAt = (html: string) => {
  const m = html.match(/bg-brass" style="left:([\d.]+)%/);
  return m ? Number(m[1]) : null;
};

describe("TodayTimeline", () => {
  it("draws nothing on a day with no shows", () => {
    expect(render([], "15:00")).toBe("");
  });

  it("an ordinary day: Day and Night shows from 13:00 to 01:00, now at 16:00", () => {
    const html = render([show({}), show({ slot: "NIGHT", startHM: "19:00", endHM: "01:00" })], "16:00");
    expect(html).toContain(">13:00<");
    expect(html).toContain(">01:00<");
    expect(handAt(html)).toBeCloseTo(25, 5); // 3 of 12 hours
    // every bar and tick stays inside the strip
    for (const left of lefts(html)) {
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(100);
    }
  });

  it("a show past midnight ends at the right edge, not before its start", () => {
    const html = render([show({ slot: "NIGHT", startHM: "19:00", endHM: "01:00" })], "20:00");
    expect(html).toContain("width:calc(100% - 2px)");
  });

  it("just after midnight the list is the new day's, all still to come: no hand on tonight's show", () => {
    // Review 10/21: the hand used to be wrapped to 24:30 and drawn inside the
    // new day's Night bar, while the list said "upcoming".
    const html = render([show({}), show({ slot: "NIGHT", startHM: "19:00", endHM: "01:00" })], "00:30");
    expect(handAt(html)).toBeNull();
  });

  it("an extra show starting at midnight gets the hand just after midnight", () => {
    const html = render([show({ slot: "EARLY", startHM: "00:00", endHM: "02:00", live: true })], "00:30");
    expect(handAt(html)).toBeCloseTo(25, 5);
  });

  it("no hand before the day starts or after it ends", () => {
    expect(handAt(render([show({})], "09:00"))).toBeNull();
    expect(handAt(render([show({})], "21:00"))).toBeNull();
  });

  it("an early extra show widens the day without pushing anything off it", () => {
    const html = render(
      [show({ slot: "EARLY", startHM: "08:00", endHM: "10:00" }), show({ slot: "NIGHT", startHM: "19:00", endHM: "01:00" })],
      "09:00",
    );
    expect(html).toContain(">08:00<");
    expect(handAt(html)).toBeCloseTo((1 / 17) * 100, 5);
    for (const left of lefts(html)) expect(left).toBeLessThanOrEqual(100);
  });

  it("a show short of people says Seat missing in red; one nobody is on says so", () => {
    const html = render([show({ short: true, seatsMissing: 1, names: ["Priya"] }), show({ names: [] })], "12:00");
    expect(html).toContain("Seat missing");
    expect(html).toContain("ring-danger-500");
    expect(html).toContain("Nobody on it");
  });

  it("two empty seats say so, the way the list under it does", () => {
    const html = render([show({ short: true, seatsMissing: 2, names: [] })], "12:00");
    expect(html).toContain("2 seats missing");
  });

  it("is hidden from screen readers, which read the list below instead", () => {
    expect(render([show({})], "15:00")).toMatch(/^<div[^>]*aria-hidden="true"/);
  });
});

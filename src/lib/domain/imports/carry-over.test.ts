import { describe, expect, it } from "vitest";
import { carryOver, lateCheckouts } from "./carry-over";
import type { WatchSale } from "./types";

/** Only the fields the rule reads; the rest are never looked at. */
function sale(over: Partial<WatchSale>): WatchSale {
  return {
    business: "WATCH",
    platform: "EBAY",
    showDate: "2026-09-30",
    paidOn: "2026-09-30",
    orderRef: "1",
    tracking: "T1",
    ...over,
  } as WatchSale;
}

const today = (n: number) =>
  Array.from({ length: n }, (_, i) => sale({ orderRef: `t${i}`, tracking: `T${i}` }));

describe("previous-day eBay orders in this morning's report", () => {
  it("carries an order sold the day before and paid today — the 09/30 case", () => {
    const late = sale({ orderRef: "35439", showDate: "2026-09-29", paidOn: "2026-09-30", tracking: "L" });
    const r = carryOver([...today(5), late]);
    expect(r.carried).toEqual([late]);
    expect(r.kept).toHaveLength(5);
    expect(r.keptToday).toEqual([]);
  });

  it("leaves a one-day report exactly as it was", () => {
    const r = carryOver(today(3));
    expect(r.kept).toHaveLength(3);
    expect(r.carried).toEqual([]);
  });

  it("does not carry an order paid on the day it sold — that is a second day's report", () => {
    const old = sale({ orderRef: "x", showDate: "2026-09-29", paidOn: "2026-09-29", tracking: "X" });
    const r = carryOver([...today(5), old]);
    expect(r.carried).toEqual([]);
    expect(r.kept).toHaveLength(6);
  });

  it("does not carry an order from two days before", () => {
    const old = sale({ orderRef: "x", showDate: "2026-09-28", paidOn: "2026-09-30", tracking: "X" });
    expect(carryOver([...today(5), old]).carried).toEqual([]);
  });

  it("never carries TikTok, where the file decides the day", () => {
    const tiktok = sale({ platform: "TIKTOK", orderRef: "x", showDate: "2026-09-29", tracking: "X" });
    expect(carryOver([...today(5), tiktok]).carried).toEqual([]);
  });

  it("has no unpaid order to go on", () => {
    const unpaid = sale({ orderRef: "x", showDate: "2026-09-29", paidOn: null, tracking: "X" });
    expect(carryOver([...today(5), unpaid]).carried).toEqual([]);
  });

  it("moves an order whole, every line of it", () => {
    const a = sale({ orderRef: "m", showDate: "2026-09-29", tracking: "M" });
    const b = sale({ orderRef: "m", showDate: "2026-09-29", tracking: "M" });
    expect(carryOver([...today(5), a, b]).carried).toEqual([a, b]);
  });

  it("does not split an order with one line that does not qualify", () => {
    const a = sale({ orderRef: "m", showDate: "2026-09-29", tracking: "M" });
    const b = sale({ orderRef: "m", showDate: "2026-09-29", paidOn: "2026-09-29", tracking: "M" });
    const r = carryOver([...today(5), a, b]);
    expect(r.carried).toEqual([]);
    expect(r.kept).toHaveLength(7);
  });

  it("keeps an order sharing a label with today's on today, so the box is whole", () => {
    const late = sale({ orderRef: "x", showDate: "2026-09-29", tracking: "T0" });
    const r = carryOver([...today(5), late]);
    expect(r.carried).toEqual([]);
    expect(r.keptToday).toEqual([late]);
    expect(r.kept).toHaveLength(6);
    expect(r.kept.every((s) => s.showDate === "2026-09-30")).toBe(true);
  });

  it("takes the latest day, whatever order the rows are in — a one-and-one report", () => {
    const late = sale({ orderRef: "x", showDate: "2026-09-29", tracking: "X" });
    for (const rows of [[late, ...today(1)], [...today(1), late]]) {
      const r = carryOver(rows);
      expect(r.carried).toEqual([late]);
      expect(r.kept.map((s) => s.showDate)).toEqual(["2026-09-30"]);
    }
  });

  it("carries late orders even when they outnumber the day's own", () => {
    const late = ["a", "b", "c"].map((o) => sale({ orderRef: o, showDate: "2026-09-29", tracking: o }));
    const r = carryOver([...late, ...today(2)]);
    expect(r.carried).toHaveLength(3);
    expect(r.kept).toHaveLength(2);
  });

  it("leaves a report of nothing but late payers to the upload to place", () => {
    // One day only, so nothing to carry here — the upload checks whether that
    // day already has a report (see runImport).
    const late = ["a", "b"].map((o) => sale({ orderRef: o, showDate: "2026-09-29", tracking: o }));
    expect(carryOver(late).carried).toEqual([]);
  });
});

describe("an eBay order checked out after midnight", () => {
  const night = (over: Partial<WatchSale>) =>
    sale({ shiftTag: "10.05.26 PM", shiftTagValid: true, showDate: "2026-10-05", paidOn: "2026-10-05", ...over });
  const report = () => [1, 2, 3].map((i) => night({ orderRef: `r${i}`, tracking: `R${i}` }));
  // Record 37378 on 10/06: four watches won in the 10/05 night show, one checkout after midnight.
  const checkout = () =>
    [1, 2, 3, 4].map((i) => night({ orderRef: "37378", tracking: "C", showDate: "2026-10-06", paidOn: "2026-10-06", lineRef: `l${i}` }));

  it("is read back to the show its items are tagged with — the 10/06 case", () => {
    const r = lateCheckouts([...report(), ...checkout()]);
    expect(r.redated).toHaveLength(4);
    expect(new Set(r.sales.map((s) => s.showDate))).toEqual(new Set(["2026-10-05"]));
  });

  it("leaves a report of one day alone", () => {
    expect(lateCheckouts(report()).redated).toEqual([]);
  });

  it("does not move an order if any item is tagged with another day", () => {
    const lines = checkout();
    lines[2] = { ...lines[2], shiftTag: "10.06.26 AM" };
    expect(lateCheckouts([...report(), ...lines]).redated).toEqual([]);
  });

  it("does not move an order with an unreadable tag", () => {
    const lines = checkout().map((l) => ({ ...l, shiftTag: "who knows", shiftTagValid: false }));
    expect(lateCheckouts([...report(), ...lines]).redated).toEqual([]);
  });

  it("does not move an order two days ahead", () => {
    const lines = checkout().map((l) => ({ ...l, showDate: "2026-10-07" }));
    expect(lateCheckouts([...report(), ...lines]).redated).toEqual([]);
  });

  it("does not move an order whose tagged day is not in the report", () => {
    // Only the late order and orders of a third day: nothing says the report is 10/05.
    const other = [1, 2].map((i) => night({ orderRef: `o${i}`, tracking: `O${i}`, showDate: "2026-10-03", shiftTag: "10.03.26 PM" }));
    expect(lateCheckouts([...other, ...checkout()]).redated).toEqual([]);
  });

  it("never touches TikTok, where the file decides the day", () => {
    const tiktok = checkout().map((l) => ({ ...l, platform: "TIKTOK" as const }));
    expect(lateCheckouts([...report(), ...tiktok]).redated).toEqual([]);
  });

  it("leaves nothing for the one-day rule to refuse afterwards", () => {
    const r = lateCheckouts([...report(), ...checkout()]);
    expect(carryOver(r.sales).kept).toHaveLength(7);
  });
});

describe("an after-midnight checkout, the awkward cases", () => {
  const tagged = (orderRef: string, day: string, tag: string, over: Partial<WatchSale> = {}) =>
    sale({ orderRef, tracking: orderRef, showDate: day, paidOn: day, shiftTag: tag, shiftTagValid: true, ...over });

  it("moves an order won across both of the day before's shows, each item keeping its show", () => {
    const r = lateCheckouts([
      tagged("a", "2026-10-05", "10.05.26 PM"),
      tagged("m", "2026-10-06", "10.05.26 AM", { lineRef: "1" }),
      tagged("m", "2026-10-06", "10.05.26 PM", { lineRef: "2" }),
    ]);
    expect(r.redated.map((s) => [s.showDate, s.shiftTag])).toEqual([
      ["2026-10-05", "10.05.26 AM"],
      ["2026-10-05", "10.05.26 PM"],
    ]);
  });

  it("still lets two whole days dropped together be refused", () => {
    const r = lateCheckouts([
      tagged("a", "2026-10-04", "10.04.26 PM"),
      tagged("b", "2026-10-05", "10.05.26 PM"),
      tagged("c", "2026-10-05", "10.05.26 PM"),
    ]);
    expect(r.redated).toEqual([]);
    expect(new Set(carryOver(r.sales).kept.map((s) => s.showDate)).size).toBe(2);
  });

  it("leaves a late checkout with a blank tag for the one-day rule, as before", () => {
    const r = lateCheckouts([
      tagged("a", "2026-10-05", "10.05.26 PM"),
      tagged("x", "2026-10-06", "", { shiftTagValid: false }),
    ]);
    expect(r.redated).toEqual([]);
  });
});

describe("the 10/09 report: labels with a date but no show, and stragglers with none", () => {
  const order = (orderRef: string, day: string, tag: string, valid = false) =>
    sale({ orderRef, tracking: orderRef, showDate: day, paidOn: day, shiftTag: valid ? tag : `${day.slice(5, 7)}.${day.slice(8)}.${day.slice(2, 4)} PM`, rawShiftTag: tag, shiftTagValid: valid });
  const night = (n: number, tag = "10.08.26 AM-PM") => Array.from({ length: n }, (_, i) => order(`d${i}`, "2026-10-08", tag));

  it("an order tagged 10.08.26 AM-PM, checked out on 10/09, is read back to 10/08", () => {
    const r = lateCheckouts([...night(5), order("38294", "2026-10-09", "10.08.26 AM-PM")]);
    expect(r.redated.map((s) => [s.orderRef, s.showDate])).toEqual([["38294", "2026-10-08"]]);
  });

  it("…and one tagged 10.08.26 NUEVO", () => {
    const r = lateCheckouts([...night(5, "10.08.26 NUEVO"), order("38179", "2026-10-09", "10.08.26 NUEVO")]);
    expect(r.redated.map((s) => s.orderRef)).toEqual(["38179"]);
  });

  it("an order with a blank label, one among many: a straggler, read back", () => {
    const r = lateCheckouts([...night(20), order("x", "2026-10-09", "")]);
    expect(r.redated.map((s) => s.orderRef)).toEqual(["x"]);
  });

  it("blank labels on a real share of the next day: not stragglers, left for the one-day rule", () => {
    const next = [1, 2, 3].map((i) => order(`n${i}`, "2026-10-09", ""));
    expect(lateCheckouts([...night(20), ...next]).redated).toEqual([]);
  });

  it("an order whose label names the next day stays there, however few", () => {
    expect(lateCheckouts([...night(20), order("y", "2026-10-09", "10.09.26 AM", true)]).redated).toEqual([]);
  });

  it("an order whose label names a third day is not moved", () => {
    expect(lateCheckouts([...night(20), order("z", "2026-10-09", "10.01.26 AM-PM")]).redated).toEqual([]);
  });

  it("two whole days dropped together, labels unreadable, are still two days", () => {
    const next = Array.from({ length: 15 }, (_, i) => order(`n${i}`, "2026-10-09", "10.09.26 AM-PM"));
    const r = lateCheckouts([...night(20), ...next]);
    expect(r.redated).toEqual([]);
    expect(new Set(carryOver(r.sales).kept.map((s) => s.showDate)).size).toBe(2);
  });
});

describe("a straggler is only read back onto a day the report really is", () => {
  it("a morning of late payers from 10/10 and one blank-label 10/11 sale: the sale stays on 10/11", () => {
    const late = Array.from({ length: 10 }, (_, i) =>
      sale({ orderRef: `L${i}`, tracking: `L${i}`, showDate: "2026-10-10", paidOn: "2026-10-11", rawShiftTag: "", shiftTagValid: false }),
    );
    const own = sale({ orderRef: "N1", tracking: "N1", showDate: "2026-10-11", paidOn: "2026-10-11", rawShiftTag: "", shiftTagValid: false });
    const r = lateCheckouts([...late, own]);
    expect(r.redated).toEqual([]);
    // …and the late payers are still carried back on their own, as before.
    expect(carryOver(r.sales).carried).toHaveLength(10);
  });

  it("a straggler next to the day's own orders and some late payers from the day before: still read back", () => {
    const own = Array.from({ length: 20 }, (_, i) => sale({ orderRef: `d${i}`, tracking: `d${i}`, showDate: "2026-10-08", paidOn: "2026-10-08", rawShiftTag: "10.08.26 AM-PM" }));
    const before = sale({ orderRef: "b", tracking: "b", showDate: "2026-10-07", paidOn: "2026-10-08", rawShiftTag: "10.07.26 AM-PM" });
    const straggler = sale({ orderRef: "s", tracking: "s", showDate: "2026-10-09", paidOn: "2026-10-09", rawShiftTag: "" });
    const r = lateCheckouts([...own, before, straggler]);
    expect(r.redated.map((x) => x.orderRef)).toEqual(["s"]);
    const c = carryOver(r.sales);
    expect([c.carried.map((x) => x.orderRef), new Set(c.kept.map((x) => x.showDate))]).toEqual([["b"], new Set(["2026-10-08"])]);
  });
});

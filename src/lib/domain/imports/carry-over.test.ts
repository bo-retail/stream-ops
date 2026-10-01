import { describe, expect, it } from "vitest";
import { carryOver } from "./carry-over";
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

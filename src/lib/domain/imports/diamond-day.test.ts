import { describe, expect, it } from "vitest";
import { coversNight, shareDiamondDay } from "./diamond-day";
import type { WatchSale } from "./types";

// 4 PM Pacific on 10/11, as the schedule stores the night show's start.
const NIGHT = new Date("2026-10-11T23:00:00Z");
const at = (utc: string) => new Date(`2026-10-11T${utc}Z`);

function sale(overrides: Partial<WatchSale> = {}): WatchSale {
  return {
    business: "DIAMOND",
    platform: "TIKTOK",
    show: "TikTok AM",
    showDate: "2026-10-11",
    shiftTag: "10.11.26 AM",
    rawShiftTag: "1",
    shiftTagValid: false,
    orderRef: "o",
    lineRef: "l",
    buyer: "b",
    stockNumber: "E93557",
    category: "",
    qty: 1,
    unitPrice: 0,
    platformDiscount: 0,
    sellerDiscount: 0,
    netItemPrice: 0,
    shipping: 0,
    taxAndFees: 0,
    orderTotal: 0,
    createdAt: at("17:33:00"),
    paidOn: "2026-10-11",
    shipToName: "",
    state: "",
    paymentMethod: "",
    packageId: "",
    tracking: "",
    sourceFile: "diamonds.csv",
    ...overrides,
  };
}

const shows = (sales: WatchSale[]) => sales.map((s) => `${s.show} ${s.shiftTag}`);

describe("one diamond export for a day of two diamond shows", () => {
  it("gives each order the show it was placed in, counting pieces", () => {
    const out = shareDiamondDay(
      [sale(), sale({ createdAt: at("23:00:00"), qty: 2 }), sale({ createdAt: new Date("2026-10-12T04:42:00Z") })],
      "diamonds.csv",
      NIGHT,
    );
    expect(shows(out.sales)).toEqual(["TikTok AM 10.11.26 AM", "TikTok PM 10.11.26 PM", "TikTok PM 10.11.26 PM"]);
    expect(out.night).toBe(3);
  });

  it("puts a night-placed row back on the day when it was ordered before the night show", () => {
    const out = shareDiamondDay([sale({ show: "TikTok PM", shiftTag: "10.11.26 PM" })], "diamonds.csv", NIGHT);
    expect(shows(out.sales)).toEqual(["TikTok AM 10.11.26 AM"]);
  });

  it("with no night show, all of it is the day's", () => {
    const out = shareDiamondDay([sale({ createdAt: new Date("2026-10-12T04:00:00Z") })], "diamonds.csv", null);
    expect(shows(out.sales)).toEqual(["TikTok AM 10.11.26 AM"]);
    expect(out.night).toBe(0);
  });

  it("touches only the named file, and never watches", () => {
    const late = new Date("2026-10-12T04:00:00Z");
    const out = shareDiamondDay(
      [sale({ sourceFile: "other.csv", createdAt: late }), sale({ business: "WATCH", createdAt: late })],
      "diamonds.csv",
      NIGHT,
    );
    expect(out.night).toBe(0);
  });

  it("keeps a real show tag, and leaves an order with no time where it was", () => {
    const out = shareDiamondDay(
      [sale({ createdAt: new Date("2026-10-12T04:00:00Z"), shiftTag: "10.11.26 X", shiftTagValid: true }), sale({ createdAt: null })],
      "diamonds.csv",
      NIGHT,
    );
    expect(shows(out.sales)).toEqual(["TikTok PM 10.11.26 X", "TikTok AM 10.11.26 AM"]);
  });
});

describe("telling a whole-day file from a day show's own", () => {
  it("a file that stops before the night show is the day's alone", () => {
    expect(coversNight(at("22:59:59"), NIGHT)).toBe(false);
  });
  it("any order from the night show's start makes it the whole day (10/10: 7:57 PM Eastern)", () => {
    expect(coversNight(at("23:00:00"), NIGHT)).toBe(true);
    expect(coversNight(at("23:59:53"), NIGHT)).toBe(true);
  });
  it("a file running hours into the night show is", () => {
    expect(coversNight(new Date("2026-10-12T04:42:00Z"), NIGHT)).toBe(true);
  });
  it("a file with no readable time is not", () => {
    expect(coversNight(null, NIGHT)).toBe(false);
  });
});

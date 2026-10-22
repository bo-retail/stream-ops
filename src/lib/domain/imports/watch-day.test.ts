import { describe, expect, it } from "vitest";
import { shareWatchStream, showsInside, showsTouched, spansShows } from "./watch-day";
import type { TikTokShowWindow } from "./extra-shows";
import type { WatchSale } from "./types";

/*
  10/23/2026, Eastern daylight time (UTC-4). One continuous watch TikTok
  stream, 7 AM to 1 AM, over the schedule's three shows: early 7–1, day 1–7,
  night 7–1.
*/
const et = (hm: string, day = 23) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(2026, 9, day, h + 4, m));
};
const watch = (slot: string, start: string, end: string, endDay = 23): TikTokShowWindow => ({
  business: "WATCH",
  slot,
  startsAt: et(start),
  endsAt: et(end, endDay),
});
const EARLY = watch("EARLY AM", "07:00", "13:00");
const DAY = watch("DAY", "13:00", "19:00");
const NIGHT = watch("NIGHT", "19:00", "01:00", 24);
const THREE = [EARLY, DAY, NIGHT];

function sale(overrides: Partial<WatchSale> = {}): WatchSale {
  return {
    business: "WATCH",
    platform: "TIKTOK",
    show: "TikTok AM",
    showDate: "2026-10-23",
    shiftTag: "10.23.26 AM",
    rawShiftTag: "",
    shiftTagValid: false,
    orderRef: "o",
    lineRef: "l",
    buyer: "b",
    stockNumber: "973117",
    category: "",
    qty: 1,
    unitPrice: 0,
    platformDiscount: 0,
    sellerDiscount: 0,
    netItemPrice: 0,
    shipping: 0,
    taxAndFees: 0,
    orderTotal: 0,
    createdAt: et("08:00"),
    paidOn: "2026-10-23",
    shipToName: "",
    state: "",
    paymentMethod: "",
    packageId: "",
    tracking: "",
    sourceFile: "stream.csv",
    ...overrides,
  };
}

/** Five orders at each time — a real share of a show, not a stray order or two. */
const x3 = (...times: Date[]) => times.flatMap((t) => [t, t, t, t, t]);

describe("spansShows", () => {
  it("a 7 AM to 1 AM stream spans its shows", () => {
    expect(spansShows(x3(et("07:05"), et("10:00"), et("15:00"), et("21:00"), et("00:40", 24)), THREE)).toBe(true);
  });

  it("an early show's own file, a little over at both ends, does not", () => {
    expect(spansShows(x3(et("06:50"), et("09:00"), et("12:30"), et("13:20")), THREE)).toBe(false);
  });

  it("a day show's own file that went live at 12:20 does not (it would replace the early show's file)", () => {
    expect(spansShows(x3(et("12:20"), et("12:45"), et("14:00"), et("18:30"), et("19:30")), THREE)).toBe(false);
  });

  it("a day show's file with one stray order deep in the night does not (review 10/22)", () => {
    expect(spansShows([...x3(et("14:00"), et("15:00"), et("16:00")), et("21:30")], THREE)).toBe(false);
  });

  it("nor a night show's file with a few afternoon orders", () => {
    const night = Array.from({ length: 40 }, () => et("21:00"));
    expect(spansShows([...night, et("15:00"), et("15:00"), et("15:00"), et("15:00")], THREE)).toBe(false);
  });

  it("a stream whose early and night shows sold little is still a stream", () => {
    const day = Array.from({ length: 83 }, () => et("15:00"));
    const early = Array.from({ length: 8 }, () => et("09:00"));
    const night = Array.from({ length: 9 }, () => et("21:00"));
    expect(spansShows([...early, ...day, ...night], THREE)).toBe(true);
  });

  it("a stream stopped mid-afternoon still spans the shows it ran in", () => {
    expect(spansShows(x3(et("08:00"), et("11:00"), et("14:30")), THREE)).toBe(true);
  });

  it("only one show on the schedule: nothing to share", () => {
    expect(spansShows(x3(et("08:00"), et("20:00")), [NIGHT])).toBe(false);
  });

  it("a called-off show is not one an order can be inside", () => {
    expect(spansShows(x3(et("08:00"), et("15:00")), [EARLY, { ...DAY, cancelled: true }, NIGHT])).toBe(false);
  });

  it("the day and night shows only (no early show that day)", () => {
    expect(spansShows(x3(et("14:00"), et("17:00"), et("21:00")), [DAY, NIGHT])).toBe(true);
  });
});

describe("showsTouched", () => {
  it("in the day's order, whatever order the times come in", () => {
    expect(showsTouched([et("21:00"), et("08:00")], THREE)).toEqual(["EARLY AM", "NIGHT"]);
  });
});

describe("shareWatchStream", () => {
  const stream = [
    sale({ orderRef: "a", createdAt: et("07:02") }),
    sale({ orderRef: "b", createdAt: et("12:59") }),
    sale({ orderRef: "c", createdAt: et("13:00") }),
    sale({ orderRef: "d", createdAt: et("18:59"), qty: 2 }),
    sale({ orderRef: "e", createdAt: et("19:00") }),
    sale({ orderRef: "f", createdAt: et("00:59", 24) }),
  ];

  it("each order to the show on the schedule at that minute; the schedule decides the edges", () => {
    const { sales, pieces } = shareWatchStream(stream, "stream.csv", THREE);
    expect(sales.map((s) => `${s.orderRef} ${s.show}`)).toEqual([
      "a TikTok EARLY AM",
      "b TikTok EARLY AM",
      "c TikTok AM",
      "d TikTok AM",
      "e TikTok PM",
      "f TikTok PM",
    ]);
    expect([...pieces]).toEqual([
      ["EARLY AM", 2],
      ["DAY", 3],
      ["NIGHT", 2],
    ]);
  });

  it("an untagged order's tag follows its show; a tagged one keeps its own", () => {
    const { sales } = shareWatchStream(
      [sale({ orderRef: "n", createdAt: et("20:00") }), sale({ orderRef: "t", createdAt: et("20:00"), shiftTag: "10.23.26 TT PM", shiftTagValid: true })],
      "stream.csv",
      THREE,
    );
    expect(sales.map((s) => s.shiftTag)).toEqual(["10.23.26 PM", "10.23.26 TT PM"]);
  });

  it("a called-off show's hours go to the show before it", () => {
    const { sales } = shareWatchStream(stream, "stream.csv", [EARLY, { ...DAY, cancelled: true }, NIGHT]);
    expect(sales.map((s) => s.show)).toEqual([
      "TikTok EARLY AM",
      "TikTok EARLY AM",
      "TikTok EARLY AM",
      "TikTok EARLY AM",
      "TikTok PM",
      "TikTok PM",
    ]);
  });

  it("leaves other files, eBay, diamonds and unreadable times where they were", () => {
    const others = [
      sale({ sourceFile: "other.csv", createdAt: et("20:00") }),
      sale({ platform: "EBAY", show: "eBay AM", createdAt: et("20:00") }),
      sale({ business: "DIAMOND", createdAt: et("20:00") }),
      sale({ createdAt: null }),
    ];
    expect(shareWatchStream(others, "stream.csv", THREE).sales).toEqual(others);
  });
});

describe("showsInside", () => {
  it("a stream that went live at 12:40 is inside the day and night, not the early show", () => {
    expect(showsInside(x3(et("12:40"), et("14:00"), et("21:00")), THREE)).toEqual(["DAY", "NIGHT"]);
  });
});

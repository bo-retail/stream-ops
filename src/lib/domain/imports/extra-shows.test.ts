import { describe, expect, it } from "vitest";
import { expectedLinesFor } from "./expected";
import { hasExtraShow, placeOnExtraShows, replacesAnotherShowsFile, showAt, showForOrders } from "./extra-shows";
import type { TikTokShowWindow } from "./extra-shows";
import { showNameFor, slotOfSalesShow, slotOfShowName } from "./types";
import type { WatchSale } from "./types";
import { isSlot, normaliseSlotName, platformRunsSlot, slotsInOrder } from "../types";

/*
  10/15/2026, Eastern daylight time (UTC-4). The boss's early morning TikTok
  runs 7 AM to 1 PM, then the day show 1 to 7, then the night show 7 to 1.
*/
const et = (hm: string, day = 15) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(2026, 9, day, h + 4, m));
};
const TZ = "America/New_York";

const watch = (slot: string, start: string, end: string, endDay = 15): TikTokShowWindow => ({
  business: "WATCH",
  slot,
  startsAt: et(start),
  endsAt: et(end, endDay),
});
const EARLY = watch("EARLY AM", "07:00", "13:00");
const DAY = watch("DAY", "13:00", "19:00");
const NIGHT = watch("NIGHT", "19:00", "01:00", 16);
const THREE = [EARLY, DAY, NIGHT];

function sale(overrides: Partial<WatchSale> = {}): WatchSale {
  return {
    business: "WATCH",
    platform: "TIKTOK",
    show: "TikTok AM",
    showDate: "2026-10-15",
    shiftTag: "10.15.26 AM",
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
    paidOn: "2026-10-15",
    shipToName: "",
    state: "",
    paymentMethod: "",
    packageId: "",
    tracking: "",
    sourceFile: "morning.csv",
    ...overrides,
  };
}

/** Places sales whose files' first orders are given, on the given shows. */
function place(sales: WatchSale[], shows: TikTokShowWindow[], firsts: Record<string, Date | null>) {
  return placeOnExtraShows(sales, shows, (file) => firsts[file] ?? null, TZ);
}

describe("a show's name in a sales record", () => {
  it("keeps the names every stored record already has", () => {
    expect(showNameFor("TIKTOK", "DAY")).toBe("TikTok AM");
    expect(showNameFor("TIKTOK", "NIGHT")).toBe("TikTok PM");
    expect(showNameFor("EBAY", "DAY")).toBe("eBay AM");
    expect(showNameFor("EBAY", "NIGHT")).toBe("eBay PM");
  });

  it("names an extra show by its own name, and reads it back as itself — not as the day show", () => {
    expect(showNameFor("TIKTOK", "EARLY AM")).toBe("TikTok EARLY AM");
    // Ends in "AM", which is exactly how the old reading took it for the day show.
    expect(slotOfShowName("TikTok EARLY AM")).toEqual({ platform: "TIKTOK", slot: "EARLY AM" });
    expect(slotOfSalesShow("TikTok EARLY AM")).toBe("EARLY AM");
  });

  it("a stray name that is no show the app writes reads as it always did", () => {
    expect(slotOfShowName("TikTok Day")).toBeNull();
    expect(slotOfSalesShow("TikTok Day")).toBe("NIGHT");
    expect(slotOfSalesShow("TikTok Night")).toBe("NIGHT");
  });

  it("reads every stored record exactly as before", () => {
    expect(slotOfSalesShow("TikTok AM")).toBe("DAY");
    expect(slotOfSalesShow("TikTok PM")).toBe("NIGHT");
    expect(slotOfSalesShow("eBay AM")).toBe("DAY");
    expect(slotOfSalesShow("eBay PM")).toBe("NIGHT");
    expect(slotOfSalesShow("  tiktok   am ")).toBe("DAY");
    // A name that is no show at all falls back to the old last-two-letters rule.
    expect(slotOfSalesShow("something AM")).toBe("DAY");
    expect(slotOfSalesShow("")).toBe("NIGHT");
  });
});

describe("naming an extra show", () => {
  it("keeps it in capitals with single spaces", () => {
    expect(normaliseSlotName("  early   am ")).toEqual({ slot: "EARLY AM" });
    expect(isSlot("EARLY AM")).toBe(true);
    expect(isSlot("early am")).toBe(false);
  });

  it("refuses a name that would be read back as the day or night show", () => {
    for (const name of ["AM", "pm", "Day", "night", "Day show"]) {
      expect(normaliseSlotName(name)).toHaveProperty("error");
    }
  });

  it("refuses a blank, an over-long, or an oddly spelt name", () => {
    expect(normaliseSlotName("   ")).toHaveProperty("error");
    expect(normaliseSlotName("A".repeat(21))).toHaveProperty("error");
    expect(normaliseSlotName("Early|AM")).toHaveProperty("error");
  });

  it("orders show times the way they run, early morning first", () => {
    expect(slotsInOrder([{ slot: "EARLY AM", startHM: "07:00" }])).toEqual(["EARLY AM", "DAY", "NIGHT"]);
    expect(slotsInOrder([])).toEqual(["DAY", "NIGHT"]);
    expect(slotsInOrder([{ slot: "LATE", startHM: "22:00" }])).toEqual(["DAY", "NIGHT", "LATE"]);
  });
});

describe("which show a file belongs to", () => {
  it("an order falls in the show running at the time", () => {
    expect(showAt(THREE, et("07:05"))?.slot).toBe("EARLY AM");
    expect(showAt(THREE, et("12:59"))?.slot).toBe("EARLY AM");
    expect(showAt(THREE, et("13:00"))?.slot).toBe("DAY");
    expect(showAt(THREE, et("19:02"))?.slot).toBe("NIGHT");
    expect(showAt(THREE, et("05:30"))?.slot).toBe("EARLY AM");
  });
  it("a cancelled show has no orders fall in it", () => {
    expect(showAt([{ ...EARLY, cancelled: true }, DAY, NIGHT], et("08:00"))?.slot).toBe("DAY");
  });
  it("a day export that went live at 12:20 is the day show's — most of it came after 1 PM", () => {
    const times = [et("12:20"), et("13:10"), et("14:00"), et("15:30")];
    expect(showForOrders(THREE, times, et("12:20"))?.slot).toBe("DAY");
  });
  it("a tie goes to the earlier show", () => {
    expect(showForOrders(THREE, [et("12:40"), et("13:20")], null)?.slot).toBe("EARLY AM");
  });
  it("no readable order times: the first order decides", () => {
    expect(showForOrders(THREE, [], et("07:30"))?.slot).toBe("EARLY AM");
    expect(showForOrders(THREE, [], null)).toBeNull();
  });
});

describe("an extra show is TikTok only", () => {
  it("eBay runs only the day and night shows", () => {
    expect(platformRunsSlot("TIKTOK", "EARLY AM")).toBe(true);
    expect(platformRunsSlot("EBAY", "EARLY AM")).toBe(false);
    expect(platformRunsSlot("EBAY", "DAY")).toBe(true);
    expect(platformRunsSlot("EBAY", "NIGHT")).toBe(true);
  });
});

describe("never overwriting another show's file", () => {
  const set = (...o: string[]) => new Set(o);
  it("a corrected file shares orders with what it replaces: allowed", () => {
    expect(replacesAnotherShowsFile(set("1", "2"), ["1", "2", "3"], set())).toBe(false);
  });
  it("a file sharing no orders with the line's file: refused", () => {
    expect(replacesAnotherShowsFile(set("d1", "d2"), ["e1", "e2", "e3"], set())).toBe(true);
  });
  it("unless that file's orders are already safe on another line", () => {
    expect(replacesAnotherShowsFile(set("d1"), ["e1", "e2"], set("e1", "e2"))).toBe(false);
  });
  it("an empty line can always be filled", () => {
    expect(replacesAnotherShowsFile(set("d1"), [], set())).toBe(false);
  });
});

describe("placing a day's TikTok files when the schedule has an extra show", () => {
  it("the ordinary day: three files, each on its own show", () => {
    const sales = [
      sale({ sourceFile: "morning.csv", show: "TikTok AM", createdAt: et("07:12") }),
      sale({ sourceFile: "day.csv", show: "TikTok AM", createdAt: et("13:04"), orderRef: "d" }),
      sale({ sourceFile: "night.csv", show: "TikTok PM", createdAt: et("19:10"), orderRef: "n" }),
    ];
    const out = place(sales, THREE, {
      "morning.csv": et("07:12"),
      "day.csv": et("13:04"),
      "night.csv": et("19:10"),
    });
    expect(out.sales.map((s) => s.show)).toEqual(["TikTok EARLY AM", "TikTok AM", "TikTok PM"]);
    expect(out.flags.filter((f) => f.severity !== "info")).toEqual([]);
    expect(out.flags.find((f) => f.message.startsWith("morning.csv"))?.message).toContain("EARLY AM");
    // Only the early show's file moved, so only it is talked about.
    expect(out.flags.map((f) => f.message.split(":")[0])).toEqual(["morning.csv"]);
  });

  it("a day with no extra show: nothing moves and nothing is said", () => {
    const sales = [sale({ show: "TikTok AM", createdAt: et("07:12") })];
    const out = place(sales, [DAY, NIGHT], { "morning.csv": et("07:12") });
    expect(out.sales).toEqual(sales);
    expect(out.flags).toEqual([]);
    expect(hasExtraShow([DAY, NIGHT], "WATCH")).toBe(false);
  });

  it("the morning and day show exported as one file: placed on the morning, and said so", () => {
    const sales = [
      sale({ sourceFile: "both.csv", createdAt: et("07:20"), orderRef: "1" }),
      sale({ sourceFile: "both.csv", createdAt: et("11:00"), orderRef: "2" }),
      sale({ sourceFile: "both.csv", createdAt: et("15:30"), orderRef: "3" }),
      sale({ sourceFile: "both.csv", createdAt: et("16:45"), orderRef: "4" }),
    ];
    const out = place(sales, THREE, { "both.csv": et("07:20") });
    expect(new Set(out.sales.map((s) => s.show))).toEqual(new Set(["TikTok EARLY AM"]));
    const warning = out.flags.find((f) => f.severity === "warning");
    expect(warning?.message).toContain("2 order(s)"); // a tie, two and two: the earlier show
    expect(warning?.message).toContain("export each show on its own");
  });

  it("a day file whose first order came during the early show stays the day show's", () => {
    const sales = [
      sale({ sourceFile: "day.csv", createdAt: et("12:20"), orderRef: "1" }),
      sale({ sourceFile: "day.csv", createdAt: et("13:30"), orderRef: "2" }),
      sale({ sourceFile: "day.csv", createdAt: et("14:10"), orderRef: "3" }),
    ];
    const out = place(sales, THREE, { "day.csv": et("12:20") });
    expect(out.sales.map((s) => s.show)).toEqual(["TikTok AM", "TikTok AM", "TikTok AM"]);
    expect(out.flags).toEqual([]);
  });

  it("the early show cancelled: a morning file goes where it always would", () => {
    const sales = [sale({ show: "TikTok AM", createdAt: et("08:00") })];
    const out = place(sales, [{ ...EARLY, cancelled: true }, DAY, NIGHT], { "morning.csv": et("08:00") });
    expect(out.sales[0].show).toBe("TikTok AM");
  });

  it("a morning show running a little over is not called two shows", () => {
    const sales = [
      sale({ createdAt: et("07:20"), orderRef: "1" }),
      sale({ createdAt: et("13:25"), orderRef: "2" }),
    ];
    const out = place(sales, THREE, { "morning.csv": et("07:20") });
    expect(out.flags.filter((f) => f.severity === "warning")).toEqual([]);
  });

  it("a diamond file is left to the diamond split, even when diamonds have an extra show", () => {
    const diamondEarly = { ...EARLY, business: "DIAMOND" as const };
    const sales = [sale({ business: "DIAMOND", sourceFile: "diamonds.csv", createdAt: et("07:30") })];
    const out = place(sales, [diamondEarly], { "diamonds.csv": et("07:30") });
    expect(out.sales[0].show).toBe("TikTok AM");
    expect(out.flags[0].severity).toBe("warning");
  });

  it("only the business that has the extra show is re-placed", () => {
    const sales = [
      sale({ sourceFile: "watch.csv", createdAt: et("07:30") }),
      sale({ business: "DIAMOND", sourceFile: "diamonds.csv", createdAt: et("07:30"), orderRef: "x" }),
    ];
    const out = place(sales, THREE, { "watch.csv": et("07:30"), "diamonds.csv": et("07:30") });
    expect(out.sales.map((s) => s.show)).toEqual(["TikTok EARLY AM", "TikTok AM"]);
  });

  it("eBay sales are never touched", () => {
    const sales = [sale({ platform: "EBAY", show: "eBay AM", sourceFile: "ebay.csv" })];
    const out = place(sales, THREE, { "ebay.csv": et("07:00") });
    expect(out.sales).toEqual(sales);
  });

  it("a file whose order times cannot be read stays where the parse put it", () => {
    const sales = [sale({ show: "TikTok AM", createdAt: null })];
    const out = place(sales, THREE, { "morning.csv": null });
    expect(out.sales[0].show).toBe("TikTok AM");
  });

  it("the extra show alone, with the day and night off: everything is the early show's", () => {
    const sales = [sale({ createdAt: et("16:00") })];
    const out = place(sales, [EARLY], { "morning.csv": et("16:00") });
    expect(out.sales[0].show).toBe("TikTok EARLY AM");
  });
});

describe("the upload checklist on a day with an extra show", () => {
  it("lists the early show's file first, as the morning happens", () => {
    const lines = expectedLinesFor(
      [
        { business: "WATCH", platform: "TIKTOK", slot: "NIGHT", cancelled: false, startsAt: NIGHT.startsAt },
        { business: "WATCH", platform: "TIKTOK", slot: "DAY", cancelled: false, startsAt: DAY.startsAt },
        { business: "WATCH", platform: "TIKTOK", slot: "EARLY AM", cancelled: false, startsAt: EARLY.startsAt },
        { business: "WATCH", platform: "EBAY", slot: "NIGHT", cancelled: false, startsAt: NIGHT.startsAt },
      ],
      (_b, p, s) => `${p} ${s ?? ""}`.trim(),
    );
    expect(lines.map((l) => l.label)).toEqual(["TIKTOK EARLY AM", "TIKTOK DAY", "TIKTOK NIGHT", "EBAY"]);
  });
});

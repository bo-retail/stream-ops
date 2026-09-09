import { describe, expect, it } from "vitest";
import { expectedFilesFor } from "./expected";
import type { DayShow } from "./expected";

const show = (
  platform: "TIKTOK" | "EBAY",
  slot: "DAY" | "NIGHT",
  cancelled = false,
): DayShow => ({ platform, slot, cancelled });

describe("what a day's upload should contain", () => {
  it("wants one TikTok file per TikTok show", () => {
    // TikTok exports separately for each show, which is why the file is what
    // decides which show an order belongs to.
    const two = expectedFilesFor([show("TIKTOK", "DAY"), show("TIKTOK", "NIGHT")]);
    expect(two.tiktok).toBe(2);
    expect(expectedFilesFor([show("TIKTOK", "NIGHT")]).tiktok).toBe(1);
  });

  it("wants one eBay file however many eBay shows ran", () => {
    // eBay's report cannot be filtered finer than a day, which is why the tag
    // has to decide the show there instead.
    expect(expectedFilesFor([show("EBAY", "NIGHT")]).ebay).toBe(1);
    expect(expectedFilesFor([show("EBAY", "DAY"), show("EBAY", "NIGHT")]).ebay).toBe(1);
  });

  it("wants three files for the ordinary day", () => {
    const day = expectedFilesFor([
      show("TIKTOK", "DAY"),
      show("TIKTOK", "NIGHT"),
      show("EBAY", "NIGHT"),
    ]);
    expect(day).toMatchObject({ tiktok: 2, ebay: 1 });
    expect(day.describe).toBe("2 TikTok exports and 1 eBay export");
  });

  it("still wants three when eBay adds a day show", () => {
    // The R15 case: a second eBay show arrives in the same eBay file.
    const day = expectedFilesFor([
      show("TIKTOK", "DAY"),
      show("TIKTOK", "NIGHT"),
      show("EBAY", "DAY"),
      show("EBAY", "NIGHT"),
    ]);
    expect(day).toMatchObject({ tiktok: 2, ebay: 1 });
  });

  it("does not wait on a cancelled show", () => {
    const day = expectedFilesFor([
      show("TIKTOK", "DAY"),
      show("TIKTOK", "NIGHT", true),
      show("EBAY", "NIGHT"),
    ]);
    expect(day.describe).toBe("1 TikTok export and 1 eBay export");
  });

  it("wants nothing from a day that was called off entirely", () => {
    const day = expectedFilesFor([show("TIKTOK", "DAY", true), show("EBAY", "NIGHT", true)]);
    expect(day).toMatchObject({ tiktok: 0, ebay: 0 });
    expect(day.describe).toBe("nothing — no shows ran");
  });

  it("wants nothing from a day with no shows at all", () => {
    expect(expectedFilesFor([]).describe).toBe("nothing — no shows ran");
  });

  it("says one export, not one exports", () => {
    expect(expectedFilesFor([show("TIKTOK", "DAY")]).describe).toBe("1 TikTok export");
  });
});

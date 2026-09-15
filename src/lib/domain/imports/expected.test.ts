import { describe, expect, it } from "vitest";
import { expectedFilesFor, missingExports, platformsDropped, platformsOf } from "./expected";
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

describe("what a loaded report is missing", () => {
  const day = expectedFilesFor([
    show("TIKTOK", "DAY"),
    show("TIKTOK", "NIGHT"),
    show("EBAY", "NIGHT"),
  ]);

  it("is nothing when every export is there", () => {
    expect(missingExports(day, ["TIKTOK", "TIKTOK", "EBAY"])).toBeNull();
  });

  it("names the eBay export when only TikTok was loaded", () => {
    // 09/11: uploaded with its two TikTok exports and no eBay one, and read as done.
    expect(missingExports(day, ["TIKTOK", "TIKTOK"])).toBe("the eBay export");
  });

  it("counts a missing TikTok export", () => {
    expect(missingExports(day, ["TIKTOK", "EBAY"])).toBe("1 of 2 TikTok exports");
  });

  it("names both when neither arrived", () => {
    expect(missingExports(day, ["UNKNOWN"])).toBe("the TikTok exports and the eBay export");
  });

  it("waits on nothing for a cancelled eBay show", () => {
    const noEbay = expectedFilesFor([show("TIKTOK", "DAY"), show("EBAY", "NIGHT", true)]);
    expect(missingExports(noEbay, ["TIKTOK"])).toBeNull();
  });
});

describe("what a new upload would drop", () => {
  it("catches uploading only the eBay file over a day that has its TikTok ones", () => {
    expect(platformsDropped(["TIKTOK", "TIKTOK"], ["EBAY"])).toEqual(["TIKTOK"]);
  });

  it("is nothing when the new upload has everything the old one had", () => {
    expect(platformsDropped(["TIKTOK", "TIKTOK"], ["TIKTOK", "TIKTOK", "EBAY"])).toEqual([]);
  });

  it("is nothing for a first upload", () => {
    expect(platformsDropped([], ["EBAY"])).toEqual([]);
  });
});

describe("reading the stored file list", () => {
  it("reads what the import writes, and survives what it does not", () => {
    expect(platformsOf([{ name: "a.csv", platform: "TIKTOK" }, { name: "b.csv" }])).toEqual([
      "TIKTOK",
      "UNKNOWN",
    ]);
    expect(platformsOf(null)).toEqual([]);
  });
});

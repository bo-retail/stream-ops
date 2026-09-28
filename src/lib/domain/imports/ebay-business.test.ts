import { describe, expect, it } from "vitest";
import { ebayFallback, placeEbayFile } from "./ebay-business";
import type { EbayShowDay } from "./ebay-business";

const show = (
  business: "WATCH" | "DIAMOND",
  platform: "TIKTOK" | "EBAY",
  cancelled = false,
): EbayShowDay => ({ business, platform, cancelled });

describe("placing an eBay export", () => {
  /*
    The file cannot say whose it is — eBay names no seller in any of its 82
    columns — so the schedule answers instead. The point of these is that a
    diamond eBay show starts working the day it is published, with no code
    change and nothing to register.
  */

  it("gives it to whoever ran an eBay show that day", () => {
    expect(placeEbayFile([show("WATCH", "EBAY"), show("WATCH", "TIKTOK")])).toEqual({
      kind: "placed",
      business: "WATCH",
    });
  });

  it("gives it to diamonds when diamonds are the ones running eBay", () => {
    // The whole point: nothing was edited to make this work. A diamond eBay
    // show on a published schedule is enough.
    expect(
      placeEbayFile([show("DIAMOND", "EBAY"), show("WATCH", "TIKTOK"), show("DIAMOND", "TIKTOK")]),
    ).toEqual({ kind: "placed", business: "DIAMOND" });
  });

  it("asks when both ran eBay, rather than guessing", () => {
    // Two eBay reports that day and nothing in either to tell them apart. A
    // guess here would put one show's sales under the other's name and pay the
    // wrong pair, so somebody has to say.
    expect(placeEbayFile([show("WATCH", "EBAY"), show("DIAMOND", "EBAY")])).toEqual({
      kind: "ambiguous",
      candidates: ["DIAMOND", "WATCH"],
    });
  });

  it("ignores a cancelled eBay show", () => {
    // A cancelled show sold nothing, so it is not a candidate — and without
    // this it would make an unambiguous day look ambiguous.
    expect(
      placeEbayFile([show("WATCH", "EBAY"), show("DIAMOND", "EBAY", true)]),
    ).toEqual({ kind: "placed", business: "WATCH" });
  });

  it("falls back to watches when nothing eBay was scheduled", () => {
    // Reports get uploaded before a schedule is published, and for days nobody
    // put on it. Watches are the only business that has ever sold on eBay.
    expect(placeEbayFile([show("WATCH", "TIKTOK")])).toEqual({
      kind: "noShow",
      business: "WATCH",
    });
    expect(placeEbayFile([])).toEqual({ kind: "noShow", business: "WATCH" });
  });

  it("is not confused by TikTok shows on the same day", () => {
    // Both sell on TikTok every day. Only the eBay shows decide this.
    expect(
      placeEbayFile([
        show("WATCH", "TIKTOK"),
        show("DIAMOND", "TIKTOK"),
        show("DIAMOND", "EBAY"),
      ]),
    ).toEqual({ kind: "placed", business: "DIAMOND" });
  });
});

describe("what the schedule still has to answer", () => {
  const bothRanEbay = placeEbayFile([
    { business: "WATCH", platform: "EBAY", cancelled: false },
    { business: "DIAMOND", platform: "EBAY", cancelled: false },
  ]);
  const onlyWatches = placeEbayFile([{ business: "WATCH", platform: "EBAY", cancelled: false }]);

  it("asks it nothing when every file named its account", () => {
    expect(bothRanEbay.kind).toBe("ambiguous");
    expect(ebayFallback(["WATCH"], bothRanEbay)).toEqual({ kind: "none" });
    expect(ebayFallback(["WATCH", "DIAMOND"], bothRanEbay)).toEqual({ kind: "none" });
  });

  it("refuses when a file has no account and the schedule cannot choose", () => {
    expect(ebayFallback([null], bothRanEbay)).toEqual({
      kind: "unplaceable",
      candidates: ["DIAMOND", "WATCH"],
    });
  });

  it("refuses even when another file in the upload did name one", () => {
    /*
      The case that made this a rule rather than a set: one known account
      alongside one unknown, and taking a single answer for the upload would
      write the unknown file under the known one's business.
    */
    expect(ebayFallback(["WATCH", null], bothRanEbay).kind).toBe("unplaceable");
  });

  it("uses the schedule for a file with no account on an ordinary day", () => {
    expect(ebayFallback([null], onlyWatches)).toEqual({ kind: "fallback", business: "WATCH" });
  });

  it("falls back to watches when the schedule has no eBay show at all", () => {
    expect(ebayFallback([null], placeEbayFile([]))).toEqual({ kind: "fallback", business: "WATCH" });
  });

  it("says nothing about an upload with no eBay files in it", () => {
    expect(ebayFallback([], bothRanEbay)).toEqual({ kind: "none" });
  });
});

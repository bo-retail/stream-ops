import { describe, expect, it } from "vitest";
import { placeEbayFile } from "./ebay-business";
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

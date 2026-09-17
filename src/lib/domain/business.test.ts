import { describe, expect, it } from "vitest";
import {
  BUSINESSES,
  BUSINESS_LABEL,
  BUSINESS_SHORT,
  ITEM_WORD,
  SHOP_HANDLE,
  businessOfHandle,
  items,
} from "./business";

describe("placing a file by the shop that exported it", () => {
  it("knows both shops", () => {
    expect(businessOfHandle("vaultshowlive")).toBe("WATCH");
    expect(businessOfHandle("caratclublive")).toBe("DIAMOND");
  });

  it("is not fooled by case or stray spacing", () => {
    // The column is written by TikTok, not by us, and has carried trailing tabs
    // before now.
    expect(businessOfHandle("  VaultShowLive ")).toBe("WATCH");
    expect(businessOfHandle("CARATCLUBLIVE")).toBe("DIAMOND");
  });

  it("refuses a shop it does not know rather than guessing", () => {
    // A file placed on the wrong show pays the wrong pair their commission and
    // nothing downstream would ever notice, so an unknown shop stops the upload.
    expect(businessOfHandle("someoneelselive")).toBeNull();
    expect(businessOfHandle("")).toBeNull();
  });

  it("has a distinct handle for every business", () => {
    const handles = BUSINESSES.map((b) => SHOP_HANDLE[b]);
    expect(new Set(handles).size).toBe(BUSINESSES.length);
  });

  it("round-trips every business through its handle", () => {
    for (const business of BUSINESSES) {
      expect(businessOfHandle(SHOP_HANDLE[business])).toBe(business);
    }
  });
});

describe("the words", () => {
  it("names each business for a heading and for a badge", () => {
    for (const business of BUSINESSES) {
      expect(BUSINESS_LABEL[business]).toBeTruthy();
      expect(BUSINESS_SHORT[business]).toBeTruthy();
    }
    expect(BUSINESS_LABEL.DIAMOND).toBe("Diamond show");
  });

  it("counts watches and pieces", () => {
    expect(items("WATCH", 1)).toBe("1 watch");
    expect(items("WATCH", 3)).toBe("3 watches");
    expect(items("DIAMOND", 1)).toBe("1 piece");
    expect(items("DIAMOND", 3)).toBe("3 pieces");
  });

  it("counts nothing correctly too", () => {
    // Zero takes the plural in English, which is the one the naive `n === 1`
    // check gets right only by accident — so it is pinned.
    expect(items("WATCH", 0)).toBe("0 watches");
    expect(items("DIAMOND", 0)).toBe("0 pieces");
  });

  it("gives every business both forms of its item word", () => {
    for (const business of BUSINESSES) {
      expect(ITEM_WORD[business].one).toBeTruthy();
      expect(ITEM_WORD[business].many).toBeTruthy();
    }
  });
});

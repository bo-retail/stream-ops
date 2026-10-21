import { describe, expect, it } from "vitest";
import { NAV } from "@/app/(app)/nav";
import { navRows } from "./nav-rows";

/*
  The restyle grouped the admin menu under headings. Nobody is to be retrained,
  so these take the real menus the app layout draws and check that grouping
  only adds headings: every item, in its order, exactly once.
*/
const BOSS = NAV.ADMIN;
const DIRECTOR = NAV.SHIPPING_DIRECTOR;
const PACKER = NAV.SHIPPING;
const STREAMER = NAV.STREAMER;

describe("navRows", () => {
  it("keeps every menu exactly as it was: same items, same order", () => {
    for (const items of [BOSS, DIRECTOR, PACKER, STREAMER]) {
      expect(navRows(items, "/dashboard").map((r) => r.item)).toEqual(items);
    }
  });

  it("gives the admin menu one heading per run, in the order of the menu", () => {
    const headings = navRows(BOSS, "/dashboard").flatMap((r) => (r.heading ? [`${r.heading}:${r.item.label}`] : []));
    expect(headings).toEqual([
      "Shows:Releases",
      "Sales:Sales insights",
      "Shipping:Shipping log",
      "Office:Payroll",
    ]);
  });

  it("every admin item but Dashboard sits under a heading (a new page added to the menu must be given one)", () => {
    let underHeading = false;
    const ungrouped: string[] = [];
    for (const row of navRows(BOSS, "/dashboard")) {
      if (row.heading) underHeading = true;
      if (!underHeading && row.item.href !== "/dashboard") ungrouped.push(row.item.label);
    }
    expect(ungrouped).toEqual([]);
  });

  it("short menus get no headings", () => {
    for (const items of [DIRECTOR, PACKER, STREAMER]) {
      expect(navRows(items, "/dashboard").some((r) => r.heading)).toBe(false);
    }
  });

  it("lights exactly one item: the Shipping log, not Packing as well", () => {
    const lit = (items: typeof BOSS, at: string) => navRows(items, at).filter((r) => r.active).map((r) => r.item.label);
    expect(lit(BOSS, "/shipping/log")).toEqual(["Shipping log"]);
    expect(lit(DIRECTOR, "/shipping/log")).toEqual(["Shipping log"]);
    expect(lit(BOSS, "/shipping")).toEqual(["Packing"]);
    expect(lit(PACKER, "/shipping/box/abc")).toEqual(["Packing"]);
    expect(lit(BOSS, "/admin/releases/123")).toEqual(["Releases"]);
    expect(lit(BOSS, "/somewhere-else")).toEqual([]);
  });
});

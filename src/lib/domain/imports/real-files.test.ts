import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBoxes, checkIntegrity, summariseDay } from "./boxes";
import { parseEbayFile } from "./ebay";
import { parseTikTokFile } from "./tiktok";
import type { WatchSale } from "./types";

/**
 * The golden-file test: the real exports, and the numbers they must produce.
 *
 * The real files carry unmasked customer names, addresses and phone numbers on
 * the eBay side, so they are never committed. Point `STREAMOPS_IMPORT_FIXTURES`
 * at a folder holding one day's three exports and this runs; without it the
 * suite skips rather than fails, the same way the operational scripts do.
 *
 * The figures below were established independently of this code — counted
 * straight out of the CSVs, and cross-checked against the workbook produced by
 * the earlier manual run of the master specification. If a change to the parser
 * moves any of them, the parser is wrong until proven otherwise.
 */

const dir = process.env.STREAMOPS_IMPORT_FIXTURES;
const available = dir !== undefined && dir !== "" && existsSync(dir);

const suite = available ? describe : describe.skip;

suite("the real 09/08 exports", () => {
  const files = available ? readdirSync(dir!).filter((f) => f.toLowerCase().endsWith(".csv")) : [];
  const read = (name: string) => readFileSync(join(dir!, name), "utf8");

  const tiktokNames = files.filter((f) => f.startsWith("All order"));
  const ebayNames = files.filter((f) => f.toLowerCase().startsWith("ebay"));

  const tiktokResults = tiktokNames.map((name) => parseTikTokFile({ name, text: read(name) }));
  const ebayResults = ebayNames.map((name) => parseEbayFile({ name, text: read(name) }));

  const sales: WatchSale[] = [...tiktokResults, ...ebayResults].flatMap((r) => r.sales);
  const dropped = [...tiktokResults, ...ebayResults].flatMap((r) => r.dropped);
  const boxes = buildBoxes(sales);
  const summary = summariseDay(sales, boxes);

  it("finds the day's three files", () => {
    expect(tiktokNames).toHaveLength(2);
    expect(ebayNames).toHaveLength(1);
  });

  it("reads every file without a blocking flag", () => {
    const blocking = [...tiktokResults, ...ebayResults]
      .flatMap((r) => r.flags)
      .filter((f) => f.severity === "blocking");
    expect(blocking).toEqual([]);
  });

  it("produces 473 paid watches in 220 boxes", () => {
    expect(summary.watches).toBe(473);
    expect(summary.boxes).toBe(220);
  });

  it("splits them the way the earlier manual run did", () => {
    // These three figures are the Summary sheet of BO_Retail_Show_Sales_2026-09-08.
    // Ordered by show name, so eBay comes first.
    expect(summary.byShow).toEqual([
      { show: "eBay PM", watches: 166 },
      { show: "TikTok AM", watches: 164 },
      { show: "TikTok PM", watches: 143 },
    ]);
  });

  it("splits the boxes by marketplace", () => {
    expect(summary.byPlatform).toEqual([
      { platform: "TIKTOK", watches: 307, boxes: 146 },
      { platform: "EBAY", watches: 166, boxes: 74 },
    ]);
  });

  it("finds the 16 boxes holding watches from both TikTok shows", () => {
    // The reason the packing list is built per day rather than per show.
    expect(summary.boxesSpanningShows).toBe(16);
  });

  it("drops the cancelled, the unpaid and the summary rows, and nothing else", () => {
    const cancels = dropped.filter((d) => d.reason.startsWith("Canceled"));
    const unpaid = dropped.filter((d) => d.reason === "committed but never paid");
    const summaries = dropped.filter((d) => d.reason.includes("summary row"));
    expect(cancels).toHaveLength(9); // 5 on the day file, 4 on the night file
    expect(unpaid).toHaveLength(7);
    expect(summaries).toHaveLength(1);
    expect(dropped).toHaveLength(cancels.length + unpaid.length + summaries.length);
  });

  it("passes every integrity check", () => {
    expect(checkIntegrity(sales, boxes)).toEqual([]);
  });

  it("rebuilds the biggest TikTok box exactly, duplicates and all", () => {
    const box = boxes.find((b) => b.tracking === "9234690390470910236904");
    expect(box).toBeDefined();
    expect(box!.watchCount).toBe(17);
    expect(box!.items.find((i) => i.stockNumber === "49746")?.expected).toBe(3);
    expect(box!.items.find((i) => i.stockNumber === "48080")?.expected).toBe(2);
    expect(box!.buyer).toBe("mike.honcho059");
  });

  it("finds the one watch whose tag was junk and credits it to its file's shift", () => {
    // A $892 watch on 09/08 was tagged "1".
    const junk = sales.filter((s) => !s.shiftTagValid);
    expect(junk).toHaveLength(1);
    expect(junk[0].rawShiftTag).toBe("1");
    expect(junk[0].shiftTag).toBe("09.08.26 AM");
    expect(junk[0].netItemPrice).toBe(892);
  });

  it("keeps the 11 morning-tagged watches that sold in the evening show", () => {
    // Show and shift are different axes: the file says where it sold, the tag
    // says who is paid. This is the case that proves they must stay separate.
    const carried = sales.filter((s) => s.show === "TikTok PM" && s.shiftTag.endsWith("AM"));
    expect(carried).toHaveLength(11);
  });

  it("every box has a buyer, a ship-to and at least one watch", () => {
    for (const box of boxes) {
      expect(box.buyer).not.toBe("");
      expect(box.watchCount).toBeGreaterThan(0);
      expect(box.items.length).toBeGreaterThan(0);
    }
  });
});

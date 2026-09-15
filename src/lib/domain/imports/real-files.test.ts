import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBoxes, checkIntegrity, summariseDay } from "./boxes";
import { parseEbayFile } from "./ebay";
import { parseTikTokFile } from "./tiktok";
import { matchTracking, trackingCarrier } from "./tracking";
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

/**
 * The 09/14 exports — the morning the exports changed underneath the import.
 *
 * Three things were new, and each had made the upload or the packing record
 * wrong: TikTok's show tag (Seller SKU) was blank on every row; TikTok sent 106
 * of its parcels with GOFO, whose tracking numbers are `GFUS` and 14 digits; and
 * eBay order 30537 was paid with no label bought yet, which refused the whole
 * day.
 *
 * Point `STREAMOPS_IMPORT_FIXTURES_0914` at a folder holding that day's three
 * exports. Like the 09/08 suite, it skips without them, and the files are never
 * committed.
 */
const dir0914 = process.env.STREAMOPS_IMPORT_FIXTURES_0914;
const available0914 = dir0914 !== undefined && dir0914 !== "" && existsSync(dir0914);

(available0914 ? describe : describe.skip)("the real 09/14 exports", () => {
  const files = available0914
    ? readdirSync(dir0914!).filter((f) => f.toLowerCase().endsWith(".csv"))
    : [];
  const read = (name: string) => readFileSync(join(dir0914!, name), "utf8");

  const tiktok = files
    .filter((f) => f.startsWith("All order"))
    .map((name) => parseTikTokFile({ name, text: read(name) }));
  const ebay = files
    .filter((f) => f.toLowerCase().startsWith("ebay"))
    .map((name) => parseEbayFile({ name, text: read(name) }));
  const results = [...tiktok, ...ebay];

  const sales = results.flatMap((r) => r.sales);
  const dropped = results.flatMap((r) => r.dropped);
  const boxes = buildBoxes(sales);
  const summary = summariseDay(sales, boxes);
  const flags = [...results.flatMap((r) => r.flags), ...checkIntegrity(sales, boxes)];

  it("finds the day's three files", () => {
    expect(tiktok).toHaveLength(2);
    expect(ebay).toHaveLength(1);
  });

  it("imports without a single blocking flag", () => {
    expect(flags.filter((f) => f.severity === "blocking")).toEqual([]);
  });

  it("produces 591 paid watches in 293 boxes", () => {
    expect(summary.watches).toBe(591);
    expect(summary.boxes).toBe(293);
  });

  it("splits them by show and by marketplace", () => {
    expect(summary.byShow).toEqual([
      { show: "eBay AM", watches: 27 },
      { show: "eBay PM", watches: 90 },
      { show: "TikTok AM", watches: 209 },
      { show: "TikTok PM", watches: 265 },
    ]);
    expect(summary.byPlatform).toEqual([
      { platform: "TIKTOK", watches: 474, boxes: 224 },
      { platform: "EBAY", watches: 117, boxes: 69 },
    ]);
    expect(summary.boxesSpanningShows).toBe(24);
    expect(summary.largestBox).toBe(17);
  });

  it("drops the cancelled, the unpaid and the summary row, and nothing else", () => {
    expect(dropped.filter((d) => d.reason.startsWith("Canceled"))).toHaveLength(22);
    expect(dropped.filter((d) => d.reason === "committed but never paid")).toHaveLength(5);
    expect(dropped.filter((d) => d.reason.includes("summary row"))).toHaveLength(1);
    expect(dropped).toHaveLength(28);
  });

  it("counts the watch with no label yet, makes no box for it, and names it", () => {
    expect(sales.filter((s) => s.tracking === "").map((s) => s.orderRef)).toEqual(["30537"]);
    const warnings = flags.filter((f) => f.message.includes("no shipping label yet"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe("warning");
    expect(warnings[0].message).toContain("order 30537 (50983)");
  });

  it("takes GOFO in its stride", () => {
    expect(boxes.filter((b) => trackingCarrier(b.tracking) === "GOFO")).toHaveLength(106);
    expect(boxes.filter((b) => trackingCarrier(b.tracking) === null)).toEqual([]);
    expect(flags.some((f) => f.message.includes("format not seen before"))).toBe(false);
  });

  it("opens the right box from the photographed label and from the scanner's own output", () => {
    const known = boxes.map((b) => b.tracking);
    expect(matchTracking("GFUS01073044073024", known)).toEqual({
      status: "matched",
      tracking: "GFUS01073044073024",
    });
    expect(boxes.find((b) => b.tracking === "GFUS01073044073024")?.items).toEqual([
      { stockNumber: "69821", expected: 1 },
    ]);
    expect(matchTracking("GFUS01073044402755", known).status).toBe("matched");
    expect(
      boxes.find((b) => b.tracking === "GFUS01073044402755")?.items.map((i) => i.stockNumber),
    ).toEqual(["69725", "MPW-0396"]);
  });

  it("notes the blank show tags once per file, not as warnings", () => {
    expect(flags.some((f) => f.message.includes("unreadable shift tag"))).toBe(false);
    const notes = flags.filter((f) => f.message.includes("show tag (Seller SKU) is blank"));
    expect(notes.map((n) => n.severity)).toEqual(["info", "info"]);
  });

  it("notes eBay 30574's 31 cents as information", () => {
    expect(flags.find((f) => f.message.includes("30574"))?.severity).toBe("info");
  });

  it("leaves exactly one warning: the watch with no label", () => {
    expect(flags.filter((f) => f.severity === "warning")).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import type { Place } from "./inventory";
import { choosePlace, planDeduction, saleKey, wantedSales } from "./deduction";
import type { BoxState, KnownSale, SaleLine } from "./deduction";

const line = (over: Partial<SaleLine> = {}): SaleLine => ({
  platform: "TIKTOK", orderRef: "O1", lineRef: "L1", showDate: "2026-10-08", show: "TikTok PM", tracking: "T1",
  stockNumber: "49888", modelNumber: "", qty: 1, ...over,
});
const stock = (over: Partial<Record<Place, number>> = {}): Record<Place, number> => ({
  SELLABLE: 0, SAMPLE_EBAY: 0, SAMPLE_TIKTOK: 0, RANDOM_PULLS: 0, DAMAGED: 0, ...over,
});
const box = (status: BoxState["status"], scanned: Record<string, number> = {}, pieces: Record<string, string[]> = {}): BoxState => ({ status, scanned, pieces });
const cat = (...models: string[]) => new Map(models.map((m) => [m, { costCents: 3000 }]));
const PULLS = "#300 - Invicta Random Pulls";

describe("which watches the reports say were sold", () => {
  it("one per unit, keyed by order line, so the same line in two uploads is one", () => {
    const w = wantedSales([line({ qty: 2 }), line({ qty: 2 })], new Map());
    expect(w.map((x) => x.key)).toEqual([saleKey(line(), 0), saleKey(line(), 1)]);
    expect(w.every((x) => x.model === "49888" && !x.sent)).toBe(true);
  });
  it("a closed box sends its watches; an open one does not", () => {
    expect(wantedSales([line()], new Map([["T1", box("OPEN")]]))[0].sent).toBe(false);
    expect(wantedSales([line()], new Map([["T1", box("CLOSED_COMPLETE", { "49888": 1 })]]))[0].sent).toBe(true);
    expect(wantedSales([line()], new Map([["T1", box("CLOSED_UNVERIFIED")]]))[0].sent).toBe(true);
  });
  it("a box closed short sends only what was scanned", () => {
    const w = wantedSales([line({ qty: 3 })], new Map([["T1", box("CLOSED_INCOMPLETE", { "49888": 2 })]]));
    expect(w.map((x) => x.sent)).toEqual([true, true, false]);
  });
  it("no tracking yet: sold, not sent", () => {
    expect(wantedSales([line({ tracking: "" })], new Map())[0].sent).toBe(false);
  });
  it("a random pull is the watch Model # names", () => {
    expect(wantedSales([line({ stockNumber: PULLS, modelNumber: "48912" })], new Map())[0].model).toBe("48912");
  });
  it("a random pull with no Model # waits for the scan, then is the piece scanned", () => {
    expect(wantedSales([line({ stockNumber: PULLS })], new Map())[0].model).toBeNull();
    const w = wantedSales([line({ stockNumber: PULLS })], new Map([["T1", box("CLOSED_COMPLETE", {}, { [PULLS.toUpperCase()]: ["48912"] })]]));
    expect([w[0].model, w[0].sent]).toEqual(["48912", true]);
  });
  it("a random pull scanned as a different watch than Model #: the scan is what went, and it is flagged", () => {
    const w = wantedSales([line({ stockNumber: PULLS, modelNumber: "48912" })], new Map([["T1", box("CLOSED_COMPLETE", {}, { [PULLS.toUpperCase()]: ["40022"] })]]));
    expect([w[0].model, w[0].reportSaid]).toEqual(["40022", "48912"]);
  });
  it("Model # can name each watch of a line of two", () => {
    expect(wantedSales([line({ stockNumber: PULLS, modelNumber: "40022;45802", qty: 2 })], new Map()).map((x) => x.model)).toEqual(["40022", "45802"]);
  });
  it("two random pulls in one box get the pieces in the order they were scanned", () => {
    const pieces = { [PULLS.toUpperCase()]: ["11111", "22222"] };
    const w = wantedSales([line({ stockNumber: PULLS, lineRef: "L1" }), line({ stockNumber: PULLS, lineRef: "L2" })], new Map([["T1", box("CLOSED_COMPLETE", {}, pieces)]]));
    expect(w.map((x) => x.model)).toEqual(["11111", "22222"]);
  });
  it("a random pull whose piece was not scanned before the box closed short is not sent", () => {
    expect(wantedSales([line({ stockNumber: PULLS, modelNumber: "48912" })], new Map([["T1", box("CLOSED_INCOMPLETE")]]))[0].sent).toBe(false);
  });
  it("a listing with a space that names a real model is that model", () => {
    expect(wantedSales([line({ stockNumber: "Invicta 48912" })], new Map(), (m) => m === "48912")[0].model).toBe("48912");
    expect(wantedSales([line({ stockNumber: "Invicta Random Pulls" })], new Map(), (m) => m === "48912")[0].model).toBeNull();
  });
});

describe("where a sold watch comes off", () => {
  it("a listing: the shelf, then its platform's sample, then the other's", () => {
    expect(choosePlace(stock({ SELLABLE: 3 }), "TIKTOK", false)).toEqual({ place: "SELLABLE", short: false });
    expect(choosePlace(stock({ SAMPLE_TIKTOK: 1, SAMPLE_EBAY: 1 }), "TIKTOK", false).place).toBe("SAMPLE_TIKTOK");
    expect(choosePlace(stock({ SAMPLE_TIKTOK: 1, SAMPLE_EBAY: 1 }), "EBAY", false).place).toBe("SAMPLE_EBAY");
    expect(choosePlace(stock({ SAMPLE_EBAY: 1 }), "TIKTOK", false).place).toBe("SAMPLE_EBAY");
  });
  it("a random pull: random pulls, then the shelf, then the samples", () => {
    expect(choosePlace(stock({ RANDOM_PULLS: 1, SELLABLE: 5 }), "TIKTOK", true).place).toBe("RANDOM_PULLS");
    expect(choosePlace(stock({ SELLABLE: 5 }), "TIKTOK", true).place).toBe("SELLABLE");
    expect(choosePlace(stock({ SAMPLE_TIKTOK: 1 }), "TIKTOK", true).place).toBe("SAMPLE_TIKTOK");
  });
  it("none anywhere: it still comes off, below zero, and says so", () => {
    expect(choosePlace(stock({ DAMAGED: 4 }), "TIKTOK", false)).toEqual({ place: "SELLABLE", short: true });
    expect(choosePlace(stock(), "TIKTOK", true)).toEqual({ place: "RANDOM_PULLS", short: true });
  });
});

describe("what has to change", () => {
  const known = (over: Partial<KnownSale> = {}): KnownSale => ({ key: saleKey(line(), 0), model: "49888", place: "SELLABLE", status: "SOLD", flag: "", ...over });
  const plan = (lines: SaleLine[], ks: KnownSale[], boxes = new Map<string, BoxState>(), bal = new Map([["49888", stock({ SELLABLE: 5 })]]), catalogue = cat("49888", "48912", "40022")) =>
    planDeduction(wantedSales(lines, boxes), new Map(ks.map((k) => [k.key, k])), catalogue, bal);

  it("a new sale comes off the shelf at its cost", () => {
    expect(plan([line()], []).changes).toEqual([
      expect.objectContaining({ kind: "sell", model: "49888", place: "SELLABLE", costCents: 3000, sent: false, flag: "" }),
    ]);
  });
  it("the same report again changes nothing", () => {
    expect(plan([line()], [known()]).changes).toEqual([]);
  });
  it("its box closed: sent; the box reopened: back to waiting", () => {
    const closed = new Map([["T1", box("CLOSED_COMPLETE", { "49888": 1 })]]);
    expect(plan([line()], [known()], closed).changes).toEqual([expect.objectContaining({ kind: "send" })]);
    expect(plan([line()], [known({ status: "SENT" })]).changes).toEqual([expect.objectContaining({ kind: "unsend" })]);
  });
  it("a corrected report without the line puts it back where it came from", () => {
    expect(plan([], [known({ place: "SAMPLE_TIKTOK" })]).changes).toEqual([expect.objectContaining({ kind: "unsell", place: "SAMPLE_TIKTOK" })]);
  });
  it("…but one already sent is flagged for a person, never quietly reversed", () => {
    const c = plan([], [known({ status: "SENT" })]).changes;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "flag" });
  });
  it("a line put back that comes back again is sold again on the same row", () => {
    expect(plan([line()], [known({ status: "UNDONE" })]).changes).toEqual([expect.objectContaining({ kind: "sell", reuse: true })]);
  });
  it("a corrected Model # before the box went: the wrong watch goes back, the right one comes off", () => {
    const k = known({ model: "48912", place: "RANDOM_PULLS" });
    const c = plan([line({ stockNumber: PULLS, modelNumber: "40022" })], [k], new Map(), new Map([["40022", stock({ RANDOM_PULLS: 1 })], ["48912", stock()]])).changes;
    expect(c.map((x) => [x.kind, "model" in x ? x.model : ""])).toEqual([["unsell", "48912"], ["sell", "40022"]]);
  });
  it("a random pull nobody has named yet: nothing moves, and it is listed", () => {
    const p = plan([line({ stockNumber: PULLS })], []);
    expect([p.changes, p.unnamed.length]).toEqual([[], 1]);
  });
  it("a model the catalogue does not have: not taken off, and listed", () => {
    const p = plan([line({ stockNumber: "99999" })], []);
    expect([p.changes, p.unknown.length]).toEqual([[], 1]);
  });
  it("ten sold with six on the shelf: six off the shelf, then the samples, then below zero, flagged", () => {
    const lines = Array.from({ length: 10 }, (_, i) => line({ lineRef: `L${i}` }));
    const p = plan(lines, [], new Map(), new Map([["49888", stock({ SELLABLE: 6, SAMPLE_TIKTOK: 1, SAMPLE_EBAY: 1 })]]));
    const places = p.changes.map((c) => (c.kind === "sell" ? c.place : ""));
    expect(places.filter((x) => x === "SELLABLE")).toHaveLength(8);
    expect(places.filter((x) => x.startsWith("SAMPLE"))).toHaveLength(2);
    expect(p.changes.filter((c) => c.kind === "sell" && c.flag.startsWith("More sold"))).toHaveLength(2);
  });
  it("a sale from before the start date that was taken off is put back (the start date moved later)", () => {
    // Its line is no longer among the wanted ones, exactly as if the report had dropped it.
    expect(plan([], [known()]).changes).toEqual([expect.objectContaining({ kind: "unsell" })]);
  });
});

import { describe, expect, it } from "vitest";
import type { Place } from "./inventory";
import { choosePlace, planDeduction, saleKey, wantedSales } from "./deduction";
import type { BoxState, KnownSale, SaleLine } from "./deduction";

const line = (over: Partial<SaleLine> = {}): SaleLine => ({
  platform: "TIKTOK", orderRef: "O1", lineRef: "L1", showDate: "2026-10-08", show: "TikTok PM", tracking: "T1",
  stockNumber: "49888", modelNumber: "", qty: 1, batchId: "B1", uploadedAt: 1, ...over,
});
const stock = (over: Partial<Record<Place, number>> = {}): Record<Place, number> => ({
  SELLABLE: 0, SAMPLE_EBAY: 0, SAMPLE_TIKTOK: 0, RANDOM_PULLS: 0, DAMAGED: 0, ...over,
});
const box = (status: BoxState["status"], scanned: Record<string, number> = {}, pieces: Record<string, string[]> = {}): BoxState => ({ status, scanned, pieces });
const boxes = (...b: [string, BoxState][]) => new Map(b);
const cat = (...models: string[]) => new Map(models.map((m) => [m, { costCents: 3000 }]));
const PULLS = "#300 - Invicta Random Pulls";
const P = PULLS.toUpperCase();
const want = (lines: SaleLine[], b = boxes(), isModel?: (m: string) => boolean) => wantedSales(lines, b, isModel).wanted;
const key = (order = "O1", stockNumber = "49888", nth = 0) => saleKey("TIKTOK", order, stockNumber, nth);

describe("which watches the reports say were sold", () => {
  it("one per unit, keyed by order, stock number and which of them it is", () => {
    expect(want([line({ qty: 2 })]).map((x) => x.key)).toEqual([key("O1", "49888", 0), key("O1", "49888", 1)]);
  });
  it("two watches of one order whose line ids Excel rounded to the same number are still two", () => {
    const damaged = { platform: "EBAY" as const, orderRef: "33326", lineRef: "1.00839E+13" };
    const w = want([line({ ...damaged, stockNumber: "49704" }), line({ ...damaged, stockNumber: "ITK-008" }), line({ ...damaged, stockNumber: "49604" }), line({ ...damaged, stockNumber: "49604" })]);
    expect(w.map((x) => x.model)).toEqual(["49604", "49604", "49704", "ITK-008"]);
    expect(new Set(w.map((x) => x.key)).size).toBe(4);
  });
  it("an order in two uploads is read from the latest, whichever comes first", () => {
    const older = line({ batchId: "B1", uploadedAt: 1, tracking: "" });
    const newer = line({ batchId: "B2", uploadedAt: 2, tracking: "T1" });
    const b = boxes(["T1", box("CLOSED_COMPLETE", { "49888": 1 })]);
    for (const order of [[older, newer], [newer, older]]) {
      const w = want(order, b);
      expect([w.length, w[0].sent, w[0].line.tracking]).toEqual([1, true, "T1"]);
    }
  });
  it("a closed box sends what was scanned into it; an open one sends nothing", () => {
    expect(want([line()], boxes(["T1", box("OPEN")]))[0].sent).toBe(false);
    expect(want([line()], boxes(["T1", box("CLOSED_COMPLETE", { "49888": 1 })]))[0].sent).toBe(true);
  });
  it("a box marked sent without scanning sends all of it, random pulls too", () => {
    const w = want([line(), line({ stockNumber: PULLS, modelNumber: "48912", lineRef: "L2" })], boxes(["T1", box("CLOSED_UNVERIFIED")]));
    expect(w.map((x) => x.sent)).toEqual([true, true]);
  });
  it("a box closed short sends only what was scanned, and says so on the rest", () => {
    const w = want([line({ qty: 3 })], boxes(["T1", box("CLOSED_INCOMPLETE", { "49888": 2 })]));
    expect(w.map((x) => x.sent)).toEqual([true, true, false]);
    expect(w[2].note).toContain("without this watch scanned");
  });
  it("two orders in one box, closed short: the scans are handed out the same way every time", () => {
    const a = line({ orderRef: "A" }), b = line({ orderRef: "B" });
    const bx = boxes(["T1", box("CLOSED_INCOMPLETE", { "49888": 1 })]);
    expect(want([b, a], bx).map((x) => [x.line.orderRef, x.sent])).toEqual([["A", true], ["B", false]]);
    expect(want([a, b], bx).map((x) => [x.line.orderRef, x.sent])).toEqual([["A", true], ["B", false]]);
  });
  it("no tracking yet: sold, not sent", () => {
    expect(want([line({ tracking: "" })])[0].sent).toBe(false);
  });
  it("a random pull is the watch Model # names; with none it waits for the scan, then is the piece scanned", () => {
    expect(want([line({ stockNumber: PULLS, modelNumber: "48912" })])[0].model).toBe("48912");
    expect(want([line({ stockNumber: PULLS })])[0].model).toBeNull();
    const w = want([line({ stockNumber: PULLS })], boxes(["T1", box("CLOSED_COMPLETE", {}, { [P]: ["48912"] })]));
    expect([w[0].model, w[0].sent]).toEqual(["48912", true]);
  });
  it("a random pull scanned as a different watch than Model #: the scan is what went, with a note", () => {
    const w = want([line({ stockNumber: PULLS, modelNumber: "48912" })], boxes(["T1", box("CLOSED_COMPLETE", {}, { [P]: ["40022"] })]));
    expect([w[0].model, w[0].note]).toEqual(["40022", "Packed as 40022, but the report's Model # said 48912."]);
  });
  it("two random pulls in one box are matched to the pieces by Model # first, whatever order they were scanned", () => {
    const w = want(
      [line({ orderRef: "A", stockNumber: PULLS, modelNumber: "40022" }), line({ orderRef: "B", stockNumber: PULLS, modelNumber: "49604" })],
      boxes(["T1", box("CLOSED_COMPLETE", {}, { [P]: ["49604", "40022"] })]),
    );
    expect(w.map((x) => [x.model, x.note])).toEqual([["40022", ""], ["49604", ""]]);
  });
  it("Model # can name each watch of a line of two", () => {
    expect(want([line({ stockNumber: PULLS, modelNumber: "40022;45802", qty: 2 })]).map((x) => x.model)).toEqual(["40022", "45802"]);
  });
  it("a listing with a space that names a real model is that model — unless it says it is a random pull", () => {
    expect(want([line({ stockNumber: "Invicta 48912" })], boxes(), (m) => m === "48912")[0].model).toBe("48912");
    expect(want([line({ stockNumber: "Invicta 300 Random Pulls" })], boxes(), (m) => m === "300")[0].model).toBeNull();
  });
  it("a box packed before its report: what was scanned is what went; the wrong watch is listed, not quietly taken off", () => {
    const r = wantedSales([line({ stockNumber: "49604" })], boxes(["T1", box("CLOSED_COMPLETE", { "ITK-008": 1 })]));
    expect([r.wanted[0].sent, r.strays]).toEqual([false, [{ tracking: "T1", model: "ITK-008", qty: 1 }]]);
  });
  it("a random pull in a box packed before its report goes when its Model # was scanned into it", () => {
    const r = wantedSales([line({ stockNumber: PULLS, modelNumber: "48912" })], boxes(["T1", box("CLOSED_COMPLETE", { "48912": 1 })]));
    expect([r.wanted[0].sent, r.strays]).toEqual([true, []]);
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
  const known = (over: Partial<KnownSale> = {}): KnownSale => ({ key: key(), model: "49888", place: "SELLABLE", status: "SOLD", flag: "", tracking: "T1", ...over });
  const plan = (lines: SaleLine[], ks: KnownSale[], b = boxes(), bal = new Map([["49888", stock({ SELLABLE: 5 })]]), sendsOnly = false) =>
    planDeduction(want(lines, b), new Map(ks.map((k) => [k.key, k])), cat("49888", "48912", "40022"), bal, sendsOnly);

  it("a new sale comes off the shelf at its cost", () => {
    expect(plan([line()], []).changes).toEqual([expect.objectContaining({ kind: "sell", model: "49888", place: "SELLABLE", costCents: 3000, sent: false, flag: "" })]);
  });
  it("the same report again changes nothing", () => {
    expect(plan([line()], [known()]).changes).toEqual([]);
  });
  it("its box closed: sent; the box reopened: back to waiting", () => {
    expect(plan([line()], [known()], boxes(["T1", box("CLOSED_COMPLETE", { "49888": 1 })])).changes).toEqual([expect.objectContaining({ kind: "send" })]);
    expect(plan([line()], [known({ status: "SENT" })]).changes).toEqual([expect.objectContaining({ kind: "unsend" })]);
  });
  it("a corrected report without the line puts it back where it came from", () => {
    expect(plan([], [known({ place: "SAMPLE_TIKTOK" })]).changes).toEqual([expect.objectContaining({ kind: "unsell", place: "SAMPLE_TIKTOK" })]);
  });
  it("a line of two corrected to one: the second watch is put back", () => {
    expect(plan([line({ qty: 1 })], [known(), known({ key: key("O1", "49888", 1) })]).changes).toEqual([expect.objectContaining({ kind: "unsell", key: key("O1", "49888", 1) })]);
  });
  it("…but one already sent is flagged for a person, never quietly reversed", () => {
    const c = plan([], [known({ status: "SENT" })]).changes;
    expect([c.length, c[0].kind]).toEqual([1, "flag"]);
  });
  it("a line put back that comes back again is sold again on the same row", () => {
    expect(plan([line()], [known({ status: "UNDONE" })]).changes).toEqual([expect.objectContaining({ kind: "sell", reuse: true })]);
  });
  it("a corrected Model # before the box went: the wrong watch goes back, the right one comes off", () => {
    const k = known({ key: key("O1", PULLS), model: "48912", place: "RANDOM_PULLS" });
    const c = plan([line({ stockNumber: PULLS, modelNumber: "40022" })], [k], boxes(), new Map([["40022", stock({ RANDOM_PULLS: 1 })], ["48912", stock()]])).changes;
    expect(c.map((x) => [x.kind, "model" in x ? x.model : ""])).toEqual([["unsell", "48912"], ["sell", "40022"]]);
  });
  it("a random pull nobody has named yet, or a model the catalogue lacks: nothing moves, both listed", () => {
    const p = plan([line({ stockNumber: PULLS }), line({ orderRef: "O2", stockNumber: "99999" })], []);
    expect([p.changes, p.unnamed.length, p.unknown.length]).toEqual([[], 1, 1]);
  });
  it("ten sold with six on the shelf: six off the shelf, then the samples, then below zero, flagged", () => {
    const p = plan(Array.from({ length: 10 }, (_, i) => line({ orderRef: `O${i}` })), [], boxes(), new Map([["49888", stock({ SELLABLE: 6, SAMPLE_TIKTOK: 1, SAMPLE_EBAY: 1 })]]));
    const places = p.changes.map((c) => (c.kind === "sell" ? c.place : ""));
    expect([places.filter((x) => x === "SELLABLE").length, places.filter((x) => x.startsWith("SAMPLE")).length]).toEqual([8, 2]);
    expect(p.changes.filter((c) => c.kind === "sell" && c.flag.startsWith("More sold"))).toHaveLength(2);
  });
  it("switched off: nothing new comes off and nothing is put back, but a packed box still sends", () => {
    const closed = boxes(["T1", box("CLOSED_COMPLETE", { "49888": 1 })]);
    expect(plan([line(), line({ orderRef: "O2" })], [known()], closed, undefined, true).changes).toEqual([expect.objectContaining({ kind: "send", key: key() })]);
    expect(plan([], [known()], boxes(), undefined, true).changes).toEqual([]);
  });
});

describe("after the second review", () => {
  it("an eBay order won across two days keeps each day's line, in that day's report", () => {
    const d = line({ platform: "EBAY", orderRef: "2002", stockNumber: "48912", batchId: "bD", uploadedAt: 1 });
    const d1 = line({ platform: "EBAY", orderRef: "2002", stockNumber: "48913", batchId: "bD1", uploadedAt: 2 });
    expect(want([d, d1]).map((w) => w.model).sort()).toEqual(["48912", "48913"]);
  });
  it("two random pulls of one order get the same keys whatever order the file lists them in", () => {
    const a = line({ stockNumber: PULLS, modelNumber: "40022", lineRef: "1.00851E+13" });
    const b = line({ stockNumber: PULLS, modelNumber: "45802", lineRef: "1.00851E+13" });
    const keys = (ls: SaleLine[]) => want(ls).map((w) => `${w.key}=${w.model}`).sort();
    expect(keys([a, b])).toEqual(keys([b, a]));
  });
});

describe("a sale settled by hand (step 4)", () => {
  const k = (status: KnownSale["status"]): KnownSale => ({ key: key(), model: "49888", place: "SELLABLE", status, flag: "", tracking: "T1" });
  const run = (status: KnownSale["status"], lines: SaleLine[], b = boxes()) =>
    planDeduction(want(lines, b), new Map([[key(), k(status)]]), cat("49888"), new Map([["49888", stock({ SELLABLE: 5 })]])).changes;
  it("cancelled: the report still listing it never takes it off again", () => {
    expect(run("CANCELLED", [line()])).toEqual([]);
  });
  it("cancelled, but its box was packed and sent anyway: flagged for a person, stock not touched", () => {
    const c = run("CANCELLED", [line()], boxes(["T1", box("CLOSED_COMPLETE", { "49888": 1 })]));
    expect(c).toEqual([{ kind: "flag", key: key(), flag: "Cancelled, but its box was packed and sent anyway. Check whether the watch really went." }]);
  });
  it("returned: nothing changes, and no flag when the report later drops it", () => {
    expect(run("RETURNED", [line()])).toEqual([]);
    expect(run("RETURNED", [])).toEqual([]);
  });
});

describe("one order seen on two show days (review, 4 October)", () => {
  // An eBay order has one show day in every file: the parser dates all its lines
  // from the order's own Sale Date. It turns up on two days only when the import
  // keeps a late payer on the next day's report, dated that day (`carryOver`),
  // and its own day's download — taken after the payment — has it too.
  const D2 = "2026-10-02", D3 = "2026-10-03", D4 = "2026-10-04";
  const ebay = (over: Partial<SaleLine>) => line({ platform: "EBAY", orderRef: "3003", stockNumber: "49888", lineRef: "1.00851E+13", ...over });
  const own = ebay({ showDate: D2, tracking: "", batchId: "b2", uploadedAt: 2 });
  const kept = ebay({ showDate: D3, tracking: "T9", batchId: "b3", uploadedAt: 3 });
  const units = (ls: SaleLine[], b = boxes()) => want(ls, b).map((w) => `${w.key}=${w.model}@${w.line.showDate}/${w.line.tracking}${w.sent ? "/sent" : ""}`);
  const k = (nth: number, stockNumber = "49888") => saleKey("EBAY", "3003", stockNumber, nth);
  const catalogue = cat("49888", "PA", "PB", "PC");
  const bal = () => new Map(["49888", "PA", "PB", "PC"].map((m) => [m, stock({ RANDOM_PULLS: 5, SELLABLE: 5 })]));
  const knownFrom = (ls: SaleLine[], b = boxes()) =>
    new Map(want(ls, b).map((w): [string, KnownSale] => [w.key, { key: w.key, model: w.model!, place: "SELLABLE", status: w.sent ? "SENT" : "SOLD", flag: "", tracking: w.line.tracking }]));

  it("read once, from the later day where its box is — whichever was uploaded last", () => {
    expect(units([own, kept])).toEqual([`${k(0)}=49888@${D3}/T9`]);
    expect(units([kept, { ...own, uploadedAt: 9, batchId: "b2v2" }])).toEqual([`${k(0)}=49888@${D3}/T9`]);
  });
  it("…its box on the later day packed: sent", () => {
    expect(units([own, kept], boxes(["T9", box("CLOSED_COMPLETE", { "49888": 1 })]))).toEqual([`${k(0)}=49888@${D3}/T9/sent`]);
  });
  it("…a random pull of two watches, Model # on both copies, packed: both named and sent, same keys either way", () => {
    const p = (l: SaleLine) => ({ ...l, stockNumber: PULLS, qty: 2, modelNumber: "PA;PB" });
    const closed = boxes(["T9", box("CLOSED_COMPLETE", {}, { [P]: ["PB", "PA"] })]);
    expect(units([p(own), p(kept)], closed)).toEqual([`${k(0, PULLS)}=PA@${D3}/T9/sent`, `${k(1, PULLS)}=PB@${D3}/T9/sent`]);
    expect(units([p(kept), { ...p(own), uploadedAt: 9 }], closed)).toEqual(units([p(own), p(kept)], closed));
  });
  it("the key never depends on which days a run reads (a start date or the look-back between the two days)", () => {
    const all = knownFrom([own, kept], boxes(["T9", box("CLOSED_COMPLETE", { "49888": 1 })]));
    for (const read of [[kept], [own, kept]]) {
      expect(planDeduction(want(read, boxes(["T9", box("CLOSED_COMPLETE", { "49888": 1 })])), all, catalogue, bal()).changes).toEqual([]);
    }
  });
  it("only its own day read (the later day not uploaded yet): its own day, and the same key once the later day comes", () => {
    expect(units([own])).toEqual([`${k(0)}=49888@${D2}/`]);
    // Later day arrives: the same watch moves to it — same key, no second watch.
    const p = planDeduction(want([own, kept]), knownFrom([own]), catalogue, bal());
    expect(p.changes.filter((c) => c.kind === "sell" || c.kind === "unsell")).toEqual([]);
  });
  it("one day uploaded twice (corrected) is still read from the latest upload", () => {
    expect(units([ebay({ showDate: D2, modelNumber: "PA", stockNumber: PULLS, batchId: "a" }), ebay({ showDate: D2, modelNumber: "PC", stockNumber: PULLS, batchId: "b", uploadedAt: 5 })]))
      .toEqual([`${k(0, PULLS)}=PC@${D2}/T1`]);
  });
  it("a late payer carried to its own day (no shared box) is a different order from the next day's: both", () => {
    const carried = ebay({ orderRef: "5005", showDate: D2, batchId: "b2v2", uploadedAt: 5, tracking: "T5" });
    const today = ebay({ orderRef: "6006", showDate: D3, batchId: "b3", uploadedAt: 4 });
    expect(want([carried, today]).map((w) => [w.line.orderRef, w.line.showDate])).toEqual([["5005", D2], ["6006", D3]]);
  });
  it("TikTok AM and PM files both holding one order, same day: once, from the latest", () => {
    const am = line({ orderRef: "T1", show: "TikTok AM", batchId: "am", uploadedAt: 1, tracking: "" });
    const pm = line({ orderRef: "T1", show: "TikTok PM", batchId: "pm", uploadedAt: 2, tracking: "T1" });
    expect(want([am, pm]).map((w) => [w.key, w.line.show])).toEqual([[key("T1"), "TikTok PM"]]);
    expect(want([pm, am]).map((w) => [w.key, w.line.show])).toEqual([[key("T1"), "TikTok PM"]]);
  });
  it("a day with no shows: nothing", () => {
    expect(wantedSales([], boxes())).toEqual({ wanted: [], strays: [] });
    expect(planDeduction([], new Map(), catalogue, bal()).changes).toEqual([]);
  });
  it("a single day's order keeps exactly the keys it always had", () => {
    const one = line({ platform: "EBAY", orderRef: "7007", stockNumber: PULLS, modelNumber: "PA" });
    const two = { ...one, modelNumber: "PB", lineRef: "L2" };
    expect(want([two, one]).map((w) => `${w.key}=${w.model}`)).toEqual([`${saleKey("EBAY", "7007", PULLS, 0)}=PA`, `${saleKey("EBAY", "7007", PULLS, 1)}=PB`]);
  });
  it("three copies on three days (two corrected own-day files and the next day's): once, from the latest day", () => {
    expect(units([kept, own, { ...own, showDate: D4, tracking: "T4", batchId: "b4" }])).toEqual([`${k(0)}=49888@${D4}/T4`]);
  });

  // Second-round what-ifs (review 4 October).
  it("(r1) its own day's report corrected after the next day's, with a fixed Model #: the next day's copy is still read (correct it there)", () => {
    // Decided: the later show day wins over the later upload, so the watch is always read where its box is.
    // A late payer kept on the next day is corrected by uploading the next day's report again.
    const p = (l: SaleLine) => ({ ...l, stockNumber: PULLS });
    const fixed = { ...p(own), modelNumber: "PC", batchId: "b2v2", uploadedAt: 9 };
    expect(units([{ ...p(kept), modelNumber: "PA" }, fixed])).toEqual([`${k(0, PULLS)}=PA@${D3}/T9`]);
  });
  it("(r2) a TikTok order in day D's PM file and day D+1's AM file (downloads overlapping midnight): once, whichever was uploaded last", () => {
    const pm = line({ orderRef: "T7", show: "TikTok PM", showDate: D2, batchId: "pm", uploadedAt: 9, tracking: "T7" });
    const am = line({ orderRef: "T7", show: "TikTok AM", showDate: D3, batchId: "am", uploadedAt: 3, tracking: "T7" });
    expect(want([pm, am]).map((w) => [w.key, w.line.showDate])).toEqual([[key("T7"), D3]]);
    expect(want([am, { ...pm, uploadedAt: 1 }]).map((w) => [w.key, w.line.showDate])).toEqual([[key("T7"), D3]]);
  });
  // Known, not new (HEAD does the same): fails today, and will say so when it is fixed.
  it.fails("(r3) the next day's report corrected so it no longer keeps the order (its box-mate cancelled), box already packed: still sent", () => {
    // The corrected report carries it back; updateEarlierReport skips it (its own day already has it, blank tracking).
    const p = planDeduction(want([own], boxes(["T9", box("CLOSED_COMPLETE", { "49888": 1 })])), knownFrom([own, kept], boxes(["T9", box("CLOSED_COMPLETE", { "49888": 1 })])), catalogue, bal());
    expect(p.changes.filter((c) => c.kind !== "flag")).toEqual([]);
  });
  it("(r4) the next day's report removed by a person: read from its own day, same key, nothing moves", () => {
    const p = planDeduction(want([own]), knownFrom([own, kept]), catalogue, bal());
    expect(p.changes).toEqual([]);
  });
  it("(r5) a line of two on the own-day copy and of one on the next day's (one unit corrected away): the later day's one", () => {
    expect(units([{ ...own, qty: 2, uploadedAt: 9 }, kept])).toEqual([`${k(0)}=49888@${D3}/T9`]);
  });
});

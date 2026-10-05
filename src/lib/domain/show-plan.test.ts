import { describe, expect, it } from "vitest";
import {
  EBAY_CAP,
  checkPlan,
  defaultSetPrice,
  ebayRows,
  fitToStock,
  missingForEbay,
  missingForTiktok,
  propose,
  showTag,
  tiktokPriceCents,
  tiktokRows,
  type PlanCandidate,
  type PlanProduct,
} from "./show-plan";

const watch = (model: string, available: number, over: Partial<PlanCandidate> = {}): PlanCandidate => ({
  model,
  description: `INVICTA ${model}`,
  imageUrl: `https://trade.invictawatch.com/${model}.jpg`,
  costCents: 2_000,
  tpCents: 6_000,
  msrpCents: null,
  weightLb: 0.8,
  lengthIn: 6,
  widthIn: 6,
  heightIn: 6,
  ebayShippingProfile: "eBay Live Shipping Policy Small",
  available,
  soldLast7: 0,
  ...over,
});

const both = { AM: true, PM: true };
const sum = (m: Map<string, { AM: number; PM: number }>, s: "AM" | "PM") => [...m.values()].reduce((n, v) => n + v[s], 0);

describe("what a model needs", () => {
  it("eBay needs a description, a picture link and a shipping profile", () => {
    expect(missingForEbay(watch("1", 1))).toEqual([]);
    expect(missingForEbay(watch("1", 1, { description: " ", imageUrl: "", ebayShippingProfile: "" }))).toEqual([
      "description", "picture link", "eBay shipping profile",
    ]);
  });
  it("TikTok needs a description, a picture link, a weight and a box size", () => {
    expect(missingForTiktok(watch("1", 1))).toEqual([]);
    expect(missingForTiktok(watch("1", 1, { weightLb: null, heightIn: 0 }))).toEqual(["weight", "box size"]);
  });
  it("runs at a set price by default only when TP is over $120", () => {
    expect(defaultSetPrice(12_000)).toBe(false);
    expect(defaultSetPrice(12_001)).toBe(true);
    expect(defaultSetPrice(null)).toBe(false);
  });
});

describe("the suggestion", () => {
  it("never puts more than half a model's units on eBay, and splits them across both shows", () => {
    const p = propose([watch("A", 10, { soldLast7: 5 })], both);
    expect(p.get("A")).toEqual({ AM: 3, PM: 2 });
  });

  it("lets a single watch go on eBay (one show only)", () => {
    const p = propose([watch("A", 1)], both);
    expect(p.get("A")!.AM + p.get("A")!.PM).toBe(1);
  });

  it("never goes over 750 a show, however much is on the shelf", () => {
    const shelf = Array.from({ length: 900 }, (_, i) => watch(`M${i}`, 5, { soldLast7: i % 7 }));
    const p = propose(shelf, both);
    expect(sum(p, "AM")).toBeLessThanOrEqual(EBAY_CAP);
    expect(sum(p, "PM")).toBeLessThanOrEqual(EBAY_CAP);
    expect(sum(p, "AM") + sum(p, "PM")).toBe(2 * EBAY_CAP);
    for (const c of shelf) {
      const v = p.get(c.model);
      if (v) expect(v.AM + v.PM).toBeLessThanOrEqual(Math.ceil(c.available / 2));
    }
  });

  it("keeps the AM under its cap when every model has an odd number (the odd ones move to the PM)", () => {
    const shelf = Array.from({ length: 1500 }, (_, i) => watch(`M${i}`, 2));
    const p = propose(shelf, both);
    expect(sum(p, "AM")).toBeLessThanOrEqual(EBAY_CAP);
    expect(sum(p, "PM")).toBeLessThanOrEqual(EBAY_CAP);
  });

  it("puts nothing on a show that is not on the schedule, and everything on the one that is", () => {
    const p = propose([watch("A", 10)], { AM: false, PM: true });
    expect(p.get("A")).toEqual({ AM: 0, PM: 5 });
    expect(propose([watch("A", 10)], { AM: false, PM: false }).size).toBe(0);
  });

  it("leaves out a model that is not ready for eBay", () => {
    expect(propose([watch("A", 10, { ebayShippingProfile: "" })], both).size).toBe(0);
  });

  it("favours the better seller at the better margin", () => {
    const p = propose([watch("GOOD", 4000, { soldLast7: 20 }), watch("SLOW", 4000, { costCents: 5_900 })], both);
    expect(p.get("GOOD")!.AM).toBeGreaterThan(p.get("SLOW")?.AM ?? 0);
  });

  it("a day with nothing on the shelf suggests nothing", () => {
    expect(propose([], both).size).toBe(0);
  });
});

describe("checking a plan", () => {
  it("TikTok gets everything not on eBay", () => {
    const { lines, problems } = checkPlan([{ model: "A", AM: 2, PM: 1, setPrice: false }], [watch("A", 10), watch("B", 4)]);
    expect(problems).toEqual([]);
    expect(lines.find((l) => l.model === "A")!.tiktok).toBe(7);
    expect(lines.find((l) => l.model === "B")).toMatchObject({ AM: 0, PM: 0, tiktok: 4 });
  });

  it("refuses the one watch on two shows", () => {
    const { problems } = checkPlan([{ model: "A", AM: 1, PM: 1, setPrice: false }], [watch("A", 1)]);
    expect(problems.join(" ")).toMatch(/only 1 on the shelf/);
  });

  it("refuses more than 750 on a show", () => {
    const shelf = Array.from({ length: 76 }, (_, i) => watch(`M${i}`, 10));
    const { problems } = checkPlan(shelf.map((c) => ({ model: c.model, AM: 10, PM: 0, setPrice: false })), shelf);
    expect(problems.join(" ")).toMatch(/AM eBay has 760 units/);
  });

  it("refuses eBay for a model missing what eBay needs, and a set price with no TP", () => {
    const { problems } = checkPlan(
      [
        { model: "A", AM: 1, PM: 0, setPrice: false },
        { model: "B", AM: 0, PM: 0, setPrice: true },
      ],
      [watch("A", 3, { imageUrl: "" }), watch("B", 3, { tpCents: null })],
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/picture link/);
    expect(problems[1]).toMatch(/no target price/);
  });

  it("refuses a mistyped number, a model twice, and a model with nothing on the shelf", () => {
    const { problems } = checkPlan(
      [
        { model: "A", AM: NaN, PM: 0, setPrice: false },
        { model: "B", AM: 1.5, PM: 0, setPrice: false },
        { model: "C", AM: 1, PM: 0, setPrice: false },
        { model: "C", AM: 1, PM: 0, setPrice: false },
        { model: "GONE", AM: 1, PM: 0, setPrice: false },
      ],
      [watch("A", 3), watch("B", 3), watch("C", 3)],
    );
    expect(problems).toHaveLength(4);
  });

  it("holds back from TikTok a model with no box size", () => {
    const { lines } = checkPlan([], [watch("A", 5, { lengthIn: null })]);
    expect(lines[0].tiktok).toBe(0);
  });
});

describe("a saved plan against the shelf as it is now", () => {
  const saved = [{ model: "A", AM: 3, PM: 2, setPrice: true }];

  it("is unchanged when the shelf still covers it", () => {
    const { lines, cuts } = fitToStock(saved, [watch("A", 10)]);
    expect(cuts).toEqual([]);
    expect(lines[0]).toEqual({ model: "A", AM: 3, PM: 2, setPrice: true, tiktok: 5 });
  });

  it("takes a late-uploaded sale off the PM first, then the AM, and tells", () => {
    const { lines, cuts } = fitToStock(saved, [watch("A", 4)]);
    expect(lines[0]).toMatchObject({ AM: 3, PM: 1, tiktok: 0 });
    expect(fitToStock(saved, [watch("A", 2)]).lines[0]).toMatchObject({ AM: 2, PM: 0, tiktok: 0 });
    expect(cuts[0]).toMatch(/only 4 on the shelf/);
  });

  it("drops a model sold out since, and one no longer ready for eBay", () => {
    expect(fitToStock(saved, []).cuts[0]).toMatch(/none on the shelf now/);
    const { lines, cuts } = fitToStock(saved, [watch("A", 10, { ebayShippingProfile: "" })]);
    expect(lines[0]).toMatchObject({ AM: 0, PM: 0, tiktok: 10 });
    expect(cuts[0]).toMatch(/eBay shipping profile/);
  });

  it("does not keep a set price once the TP is gone", () => {
    expect(fitToStock(saved, [watch("A", 10, { tpCents: null })]).lines[0].setPrice).toBe(false);
  });

  it("gives a model new since the save all to TikTok", () => {
    expect(fitToStock(saved, [watch("A", 10), watch("NEW", 3)]).lines[1]).toMatchObject({ model: "NEW", AM: 0, PM: 0, tiktok: 3 });
  });
});

describe("the file rows", () => {
  const products = new Map<string, PlanProduct>([["A", watch("A", 9, { tpCents: 12_999 })]]);

  it("tags the eBay file with its show, as the team does: 09.08.26 PM", () => {
    expect(showTag("2026-09-08", "PM")).toBe("09.08.26 PM");
    expect(showTag("2026-10-04", "AM")).toBe("10.04.26 AM");
  });

  it("writes one eBay row per unit, at $1 or at the TP", () => {
    const rows = ebayRows([{ model: "A", AM: 2, PM: 1, setPrice: true, tiktok: 6 }], products, "2026-10-04", "AM");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ "Custom label (SKU)": "10.04.26 AM", Title: "A", Quantity: 1, "Start price": 129.99 });
    const one = ebayRows([{ model: "A", AM: 0, PM: 1, setPrice: false, tiktok: 6 }], products, "2026-10-04", "PM");
    expect(one).toHaveLength(1);
    expect(one[0]["Start price"]).toBe(1);
  });

  it("writes one TikTok row per model with the quantity left, starting bid at TP on a set price", () => {
    const rows = tiktokRows([{ model: "A", AM: 2, PM: 1, setPrice: true, tiktok: 6 }], products);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product_name: "A", quantity: 6, auction_starting_price: 129.99, price: 800 });
    expect(tiktokRows([{ model: "A", AM: 9, PM: 0, setPrice: false, tiktok: 0 }], products)).toHaveLength(0);
  });

  it("prices TikTok at half the MSRP once there is one", () => {
    expect(tiktokPriceCents({ msrpCents: 129_500 })).toBe(64_750);
    expect(tiktokPriceCents({ msrpCents: null })).toBe(80_000);
  });
});

describe("files already downloaded stay as they were", () => {
  const plan = [{ model: "A", AM: 3, PM: 3, setPrice: false }];

  it("a re-saved plan cannot move a downloaded file's units (the reviewer's 13 listed on 10)", () => {
    const { problems } = checkPlan([{ model: "A", AM: 0, PM: 0, setPrice: false }], [watch("A", 10)], EBAY_CAP, { AM: { A: 3 } });
    expect(problems.join(" ")).toMatch(/AM eBay file is already out with 3/);
    // …and TikTok, made after, leaves the AM's 3 out.
    expect(fitToStock(plan, [watch("A", 10)], { AM: { A: 3 } }).lines[0]).toMatchObject({ AM: 3, PM: 3, tiktok: 4 });
  });

  it("with the TikTok file out, eBay can only take what TikTok did not", () => {
    const { problems } = checkPlan([{ model: "A", AM: 4, PM: 4, setPrice: false }], [watch("A", 10)], EBAY_CAP, { tiktok: { A: 4 } });
    expect(problems.join(" ")).toMatch(/only 6 of the 10 on the shelf are not in a file already out/);
    expect(checkPlan([{ model: "A", AM: 3, PM: 3, setPrice: false }], [watch("A", 10)], EBAY_CAP, { tiktok: { A: 4 } }).problems).toEqual([]);
  });

  it("the shelf dropping after the TikTok file is out cuts the eBay files not yet out (the reviewer's 10 listed on 8)", () => {
    const { lines } = fitToStock([{ model: "A", AM: 4, PM: 4, setPrice: false }], [watch("A", 8)], { tiktok: { A: 2 } });
    expect(lines[0]).toMatchObject({ AM: 4, PM: 2, tiktok: 2 });
    expect(lines[0].AM + lines[0].PM + lines[0].tiktok).toBe(8);
  });

  it("a model losing its eBay profile after the AM file is out keeps the AM's units and loses only the PM's", () => {
    const { lines } = fitToStock(plan, [watch("A", 10, { ebayShippingProfile: "" })], { AM: { A: 3 } });
    expect(lines[0]).toMatchObject({ AM: 3, PM: 0, tiktok: 7 });
  });

  it("when the files out already list more than the shelf, says how many to take down by hand", () => {
    const { lines, overListed } = fitToStock(plan, [watch("A", 5)], { AM: { A: 3 }, PM: { A: 3 }, tiktok: { A: 2 } });
    expect(lines[0]).toMatchObject({ AM: 3, PM: 3, tiktok: 2 });
    expect(overListed[0]).toMatch(/Take 3 down/);
    expect(fitToStock(plan, [], { AM: { A: 3 } }).overListed[0]).toMatch(/none on the shelf/);
  });

  it("never lists more than the shelf from the files not yet out, whatever is out (random check)", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; i < 2000; i++) {
      const shelf = rnd(12);
      const AM = rnd(6), PM = rnd(6);
      const issued = { ...(rnd(2) ? { AM: { A: rnd(5) } } : {}), ...(rnd(2) ? { PM: { A: rnd(5) } } : {}), ...(rnd(2) ? { tiktok: { A: rnd(8) } } : {}) };
      const cands = shelf > 0 ? [watch("A", shelf)] : [];
      const { lines } = fitToStock([{ model: "A", AM, PM, setPrice: false }], cands, issued);
      if (!lines[0]) continue;
      const fixed = (issued.AM?.A ?? 0) + (issued.PM?.A ?? 0) + (issued.tiktok?.A ?? 0);
      const free = (issued.AM ? 0 : lines[0].AM) + (issued.PM ? 0 : lines[0].PM) + (issued.tiktok ? 0 : lines[0].tiktok);
      expect(free).toBeLessThanOrEqual(Math.max(0, shelf - fixed));
      expect(Math.min(lines[0].AM, lines[0].PM, lines[0].tiktok)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("TikTok's price is sane", () => {
  it("ignores an MSRP that is a typing slip", () => {
    expect(tiktokPriceCents({ msrpCents: 1 })).toBe(80_000);
  });
  it("is never below the auction's opening bid", () => {
    expect(tiktokPriceCents({ msrpCents: null }, 95_000)).toBe(95_000);
    expect(tiktokPriceCents({ msrpCents: 5_000 }, 100)).toBe(2_500);
  });
});

describe("a file out that now lists more than the shelf does not block the rest of the plan", () => {
  const others = { model: "B", AM: 0, PM: 2, setPrice: false };

  it("AM file out with 4, the shelf drops to 3: a change to another model still saves", () => {
    const { problems } = checkPlan([{ model: "A", AM: 4, PM: 0, setPrice: false }, others], [watch("A", 3), watch("B", 5)], EBAY_CAP, { AM: { A: 4 } });
    expect(problems).toEqual([]);
  });

  it("AM file out with 3, then A's eBay profile is cleared: a change to another model still saves", () => {
    const { problems } = checkPlan(
      [{ model: "A", AM: 3, PM: 0, setPrice: false }, others],
      [watch("A", 10, { ebayShippingProfile: "" }), watch("B", 5)],
      EBAY_CAP,
      { AM: { A: 3 } },
    );
    expect(problems).toEqual([]);
  });

  it("TikTok file out with 4, the shelf drops to 3: a change to another model still saves", () => {
    const { problems } = checkPlan([{ model: "A", AM: 0, PM: 0, setPrice: false }, others], [watch("A", 3), watch("B", 5)], EBAY_CAP, { tiktok: { A: 4 } });
    expect(problems).toEqual([]);
  });

  it("…but more eBay for that model, beyond what is free, is still refused", () => {
    const { problems } = checkPlan([{ model: "A", AM: 4, PM: 1, setPrice: false }], [watch("A", 4)], EBAY_CAP, { AM: { A: 4 } });
    expect(problems.join(" ")).toMatch(/1 more on eBay, but only 0/);
  });
});

import { describe, expect, it } from "vitest";
import { confidenceFor, fileLoadedFor, formatIndex, kindOf, scoreSellers, solve } from "./sellers";
import type { SellerShow } from "./sellers";

let next = 0;
function show(over: Partial<SellerShow> & { people: string[]; revenue: number }): SellerShow {
  next += 1;
  return {
    id: `s${next}`,
    platform: over.platform ?? "TIKTOK",
    slot: over.slot ?? "NIGHT",
    dateISO: over.dateISO ?? "2026-10-01",
    minutes: over.minutes ?? 240,
    revenueCents: over.revenue,
    units: over.units ?? 10,
    people: over.people,
    ...(over.costedRevenueCents !== undefined ? { costedRevenueCents: over.costedRevenueCents, cogsCents: over.cogsCents } : {}),
  };
}
const seller = (r: ReturnType<typeof scoreSellers>, id: string) => {
  const s = r.sellers.find((x) => x.userId === id);
  if (!s) throw new Error(`no score for ${id}`);
  return s;
};

/** A small deterministic random, so the simulated weeks are the same every run. */
function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

describe("solve", () => {
  it("solves a small system", () => {
    const x = solve(
      [
        [4, 1],
        [1, 3],
      ],
      [1, 2],
    );
    expect(x[0]).toBeCloseTo(1 / 11, 9);
    expect(x[1]).toBeCloseTo(7 / 11, 9);
  });
});

describe("scoreSellers — the ordinary week", () => {
  it("an empty range scores nobody", () => {
    expect(scoreSellers([])).toEqual({ baselines: [], sellers: [], pairings: [], showsScored: 0 });
  });

  it("judges each show against its own kind, so nights do not win by being nights", () => {
    // Nina only works nights, Dee only days. Nights sell 5x days. Both sell
    // exactly what their kind normally does — neither is better.
    const shows = [
      ...Array.from({ length: 12 }, () => show({ slot: "NIGHT", revenue: 500_000, people: ["nina"] })),
      ...Array.from({ length: 12 }, () => show({ slot: "DAY", revenue: 100_000, people: ["dee"] })),
    ];
    const r = scoreSellers(shows);
    expect(seller(r, "nina").index).toBeCloseTo(0, 6);
    expect(seller(r, "dee").index).toBeCloseTo(0, 6);
    expect(seller(r, "nina").revenueCents).toBe(6_000_000);
  });

  it("eBay and TikTok are different kinds too", () => {
    expect(kindOf({ platform: "EBAY", slot: "NIGHT" })).not.toBe(kindOf({ platform: "TIKTOK", slot: "NIGHT" }));
  });

  it("a better seller on the same kind of show scores above a worse one", () => {
    const shows = [
      ...Array.from({ length: 15 }, () => show({ revenue: 600_000, people: ["good"] })),
      ...Array.from({ length: 15 }, () => show({ revenue: 400_000, people: ["less"] })),
    ];
    const r = scoreSellers(shows);
    expect(seller(r, "good").rawIndex).toBeCloseTo(0.2, 6);
    expect(seller(r, "less").rawIndex).toBeCloseTo(-0.2, 6);
    expect(r.sellers[0].userId).toBe("good");
    expect(seller(r, "good").effect).toBeGreaterThan(0);
    expect(seller(r, "less").effect).toBeLessThan(0);
  });

  it("judges per hour, so a show kept on late does not look better for being long", () => {
    const shows = [
      ...Array.from({ length: 10 }, () => show({ revenue: 400_000, minutes: 240, people: ["norm"] })),
      ...Array.from({ length: 10 }, () => show({ revenue: 600_000, minutes: 360, people: ["long"] })),
    ];
    const r = scoreSellers(shows);
    expect(seller(r, "long").rawIndex).toBeCloseTo(0, 6);
    expect(seller(r, "norm").rawIndex).toBeCloseTo(0, 6);
  });
});

describe("scoreSellers — the partner", () => {
  /*
    The case the partner-adjusted reading exists for. Ana is ordinary but is
    always paired with Star, who lifts every show. Bea is just as ordinary and
    always paired with Weak. Straight vs-expected flatters Ana and punishes
    Bea; partners rotating now and then is enough for the model to see Ana and
    Bea are the same seller.
  */
  it("takes the partner out", () => {
    const truth: Record<string, number> = { star: 0.4, ana: 0, bea: 0, weak: -0.3, x: 0, y: 0 };
    const rand = rng(7);
    const shows: SellerShow[] = [];
    const add = (a: string, b: string) => {
      const lift = (truth[a] + truth[b]) / 2;
      const noise = (rand() - 0.5) * 0.1;
      shows.push(show({ revenue: Math.round(500_000 * (1 + lift + noise)), people: [a, b] }));
    };
    for (let i = 0; i < 25; i++) add("ana", "star");
    for (let i = 0; i < 25; i++) add("bea", "weak");
    // The occasional rotation the rota gives anyway.
    for (let i = 0; i < 6; i++) {
      add("ana", "x");
      add("bea", "x");
      add("star", "y");
      add("weak", "y");
      add("ana", "y");
      add("bea", "y");
    }
    const r = scoreSellers(shows);

    // Straight vs-expected: Ana well above Bea, purely from her partner.
    expect(seller(r, "ana").rawIndex - seller(r, "bea").rawIndex).toBeGreaterThan(0.2);
    // Partner-adjusted: the gap all but closes.
    expect(Math.abs(seller(r, "ana").effect - seller(r, "bea").effect)).toBeLessThan(0.1);
    // Ana is flagged as nearly always with Star.
    expect(seller(r, "ana").mainPartner).toEqual({ userId: "star", share: 25 / 37 });
    // And the real difference is still found.
    expect(seller(r, "star").effect).toBeGreaterThan(seller(r, "ana").effect + 0.2);
    expect(seller(r, "weak").effect).toBeLessThan(seller(r, "bea").effect - 0.15);
  });

  it("recovers who is good in a realistic rotating rota", () => {
    const truth: Record<string, number> = { a: 0.3, b: 0.15, c: 0, d: -0.1, e: -0.25, f: 0.05 };
    const names = Object.keys(truth);
    const rand = rng(42);
    const shows: SellerShow[] = [];
    for (let i = 0; i < 160; i++) {
      const p = names[Math.floor(rand() * names.length)];
      let q = names[Math.floor(rand() * names.length)];
      while (q === p) q = names[Math.floor(rand() * names.length)];
      const kind = rand() < 0.5 ? { platform: "TIKTOK", slot: "NIGHT", base: 600_000 } : { platform: "EBAY", slot: "DAY", base: 120_000 };
      const lift = (truth[p] + truth[q]) / 2;
      shows.push(show({ ...kind, revenue: Math.round(kind.base * (1 + lift + (rand() - 0.5) * 0.3)), people: [p, q] }));
    }
    const r = scoreSellers(shows);
    const byEffect = [...r.sellers].sort((x, y) => y.effect - x.effect).map((s) => s.userId);
    expect(byEffect[0]).toBe("a");
    expect(byEffect[byEffect.length - 1]).toBe("e");
  });

  it("lists a pair only once they have worked enough shows together", () => {
    const shows = [
      ...Array.from({ length: 3 }, () => show({ revenue: 500_000, people: ["p", "q"] })),
      ...Array.from({ length: 2 }, () => show({ revenue: 500_000, people: ["p", "r"] })),
    ];
    const pairs = scoreSellers(shows).pairings.map((p) => `${p.a}+${p.b}`);
    expect(pairs).toEqual(["p+q"]);
  });

  it("finds a pair who do better together than either does apart", () => {
    const rand = rng(3);
    const jitter = () => 1 + (rand() - 0.5) * 0.2;
    const shows = [
      ...Array.from({ length: 12 }, () => show({ revenue: Math.round(700_000 * jitter()), people: ["m", "n"] })),
      ...Array.from({ length: 12 }, () => show({ revenue: Math.round(450_000 * jitter()), people: ["m", "o"] })),
      ...Array.from({ length: 12 }, () => show({ revenue: Math.round(450_000 * jitter()), people: ["n", "o"] })),
    ];
    const mn = scoreSellers(shows).pairings.find((p) => p.a === "m" && p.b === "n")!;
    expect(mn.together).toBeGreaterThan(0);
    expect(mn.chemistry!).toBeGreaterThan(0.15);
    expect(mn.chemistryClear).toBe(true);
  });

  // Review 10/21: with no real chemistry at all, a dozen noisy nights still
  // read ±20% by chance. The page must not paint that as a verdict.
  it("a rota with no chemistry shows no clear difference", () => {
    const truth: Record<string, number> = { a: 0.3, b: 0.15, c: 0.05, d: 0, e: -0.1, f: -0.2 };
    const names = Object.keys(truth);
    // Thirty different 90-day rotas: one rota can be unlucky, a rate cannot.
    let said = 0;
    let clear = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed * 7919);
      const shows: SellerShow[] = [];
      for (let i = 0; i < 180; i++) {
        const p = names[Math.floor(rand() * names.length)];
        let q = names[Math.floor(rand() * names.length)];
        while (q === p) q = names[Math.floor(rand() * names.length)];
        const lift = (truth[p] + truth[q]) / 2;
        shows.push(show({ revenue: Math.round(500_000 * (1 + lift + (rand() - 0.5) * 0.6)), people: [p, q] }));
      }
      const pairs = scoreSellers(shows).pairings;
      said += pairs.filter((p) => p.chemistry !== null).length;
      clear += pairs.filter((p) => p.chemistryClear).length;
    }
    expect(said).toBeGreaterThan(100);
    // At most one pair in twenty painted as a verdict when nothing is there.
    expect(clear / said).toBeLessThan(0.05);
  });

  // Review 10/21: a strong pair who never work apart read as "better
  // together" only because the model had learnt their result into both.
  it("says nothing about a pair's chemistry when they never work apart", () => {
    const shows = [
      ...Array.from({ length: 10 }, () => show({ revenue: 750_000, people: ["ava", "bo"] })),
      ...Array.from({ length: 10 }, () => show({ revenue: 500_000, people: ["cy", "di"] })),
      ...Array.from({ length: 10 }, () => show({ revenue: 350_000, people: ["eve", "fay"] })),
    ];
    const pairs = scoreSellers(shows).pairings;
    expect(pairs).toHaveLength(3);
    for (const p of pairs) {
      expect(p.chemistry).toBeNull();
      expect(p.predicted).toBeNull();
    }
  });

  it("a pair who are exactly what each is apart show no chemistry", () => {
    // Everybody sells at their own level whoever they are with.
    const level: Record<string, number> = { p: 0.3, q: 0.1, r: -0.1, s: -0.3 };
    const names = Object.keys(level);
    const shows: SellerShow[] = [];
    for (let k = 0; k < 6; k++) {
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const lift = (level[names[i]] + level[names[j]]) / 2;
          shows.push(show({ revenue: Math.round(500_000 * (1 + lift)), people: [names[i], names[j]] }));
        }
      }
    }
    const pairs = scoreSellers(shows, { minTogetherShows: 6, minApartShows: 6 }).pairings;
    expect(pairs).toHaveLength(6);
    for (const p of pairs) {
      expect(p.chemistry).not.toBeNull();
      expect(Math.abs(p.chemistry!)).toBeLessThan(0.08);
    }
  });
});

describe("scoreSellers — the awkward cases", () => {
  it("four great shows do not outrank forty good ones", () => {
    const shows = [
      ...Array.from({ length: 4 }, () => show({ revenue: 800_000, people: ["new"] })),
      ...Array.from({ length: 40 }, () => show({ revenue: 600_000, people: ["steady"] })),
      ...Array.from({ length: 40 }, () => show({ revenue: 450_000, people: ["filler"] })),
    ];
    const r = scoreSellers(shows);
    const fresh = seller(r, "new");
    const steady = seller(r, "steady");
    expect(fresh.rawIndex).toBeGreaterThan(steady.rawIndex);
    // Pulled hard toward average on four shows; barely at all on forty.
    expect(fresh.index).toBeLessThan(fresh.rawIndex * 0.6);
    expect(Math.abs(steady.index - steady.rawIndex)).toBeLessThan(0.02);
    // And not ranked at all until there are enough shows.
    expect(fresh.ranked).toBe(false);
    expect(steady.ranked).toBe(true);
    expect(r.sellers.map((s) => s.userId)).toEqual(["steady", "filler", "new"]);
    expect(fresh.confidence).toBe("early");
    expect(steady.confidence).toBe("solid");
  });

  it("one freak night cannot carry somebody", () => {
    const shows = [
      show({ revenue: 50_000_000, people: ["lucky"] }),
      ...Array.from({ length: 30 }, () => show({ revenue: 500_000, people: ["other"] })),
    ];
    const r = scoreSellers(shows);
    // Capped at 4x expected in the model: a +300% ceiling, then pulled by ridge.
    expect(seller(r, "lucky").effect).toBeLessThan(3);
  });

  it("a show that sold nothing counts as a bad night, not as missing", () => {
    const shows = [
      show({ revenue: 0, people: ["zero"] }),
      ...Array.from({ length: 10 }, () => show({ revenue: 500_000, people: ["other"] })),
    ];
    expect(seller(scoreSellers(shows), "zero").rawIndex).toBeCloseTo(-1, 6);
  });

  it("a show with no length is left out rather than dividing by zero", () => {
    const r = scoreSellers([show({ revenue: 500_000, minutes: 0, people: ["a"] })]);
    expect(r.sellers).toEqual([]);
    expect(r.showsScored).toBe(0);
  });

  it("a show nobody was on still sets what its kind normally makes", () => {
    const shows = [
      ...Array.from({ length: 10 }, () => show({ revenue: 1_000_000, people: [] })),
      ...Array.from({ length: 10 }, () => show({ revenue: 500_000, people: ["half"] })),
    ];
    const r = scoreSellers(shows);
    expect(r.baselines[0].shows).toBe(20);
    expect(seller(r, "half").rawIndex).toBeCloseTo(500_000 / 750_000 - 1, 6);
  });

  it("a kind of show that sold nothing at all has no normal to beat", () => {
    const r = scoreSellers([
      show({ platform: "EBAY", slot: "DAY", revenue: 0, people: ["a"] }),
      show({ platform: "EBAY", slot: "DAY", revenue: 0, people: ["b"] }),
    ]);
    expect(r.sellers).toEqual([]);
  });

  it("the same person listed twice on a show counts once", () => {
    const r = scoreSellers([show({ revenue: 500_000, people: ["dup", "dup"] }), show({ revenue: 500_000, people: ["o"] })]);
    expect(seller(r, "dup").shows).toBe(1);
  });

  it("returns refunds as negative sales without breaking", () => {
    const shows = [
      show({ revenue: -20_000, people: ["refund"] }),
      ...Array.from({ length: 10 }, () => show({ revenue: 500_000, people: ["other"] })),
    ];
    const r = scoreSellers(shows);
    expect(Number.isFinite(seller(r, "refund").effect)).toBe(true);
    expect(seller(r, "refund").rawIndex).toBeLessThan(-1);
  });

  it("splits each person's shows by kind", () => {
    const shows = [
      ...Array.from({ length: 5 }, () => show({ slot: "NIGHT", revenue: 600_000, people: ["k"] })),
      ...Array.from({ length: 5 }, () => show({ slot: "NIGHT", revenue: 400_000, people: ["j"] })),
      ...Array.from({ length: 3 }, () => show({ slot: "DAY", revenue: 100_000, people: ["k"] })),
    ];
    const k = seller(scoreSellers(shows), "k");
    expect(k.byKind.map((b) => b.kind)).toEqual(["TIKTOK|NIGHT", "TIKTOK|DAY"]);
    expect(k.byKind[0].index).toBeCloseTo(0.2, 6);
    expect(k.byKind[1].index).toBeCloseTo(0, 6);
  });
});

describe("confidence and wording", () => {
  it("names how sure the number is", () => {
    expect(confidenceFor(9)).toBe("early");
    expect(confidenceFor(10)).toBe("fair");
    expect(confidenceFor(25)).toBe("solid");
  });

  it("writes a score the way the page shows it", () => {
    expect(formatIndex(0.144)).toBe("+14%");
    expect(formatIndex(-0.031)).toBe("−3%");
    expect(formatIndex(0.004)).toBe("0%");
  });
});

describe("main partner", () => {
  it("is null for somebody who only ever streamed alone", () => {
    const r = scoreSellers([show({ revenue: 500_000, people: ["solo"] }), show({ revenue: 400_000, people: ["o"] })]);
    expect(seller(r, "solo").mainPartner).toBeNull();
  });

  it("names the most frequent partner and the share", () => {
    const shows = [
      ...Array.from({ length: 3 }, () => show({ revenue: 500_000, people: ["p", "q"] })),
      show({ revenue: 500_000, people: ["p", "r"] }),
    ];
    expect(seller(scoreSellers(shows), "p").mainPartner).toEqual({ userId: "q", share: 0.75 });
  });
});

describe("fileLoadedFor", () => {
  const day = "2026-10-20";
  // Review 10/21: the day file in made the night show read as a $0 night.
  it("a TikTok show is covered by its own file, not the other show's", () => {
    const loaded = new Set([`TIKTOK|DAY|${day}`]);
    expect(fileLoadedFor(loaded, { platform: "TIKTOK", slot: "DAY", dateISO: day })).toBe(true);
    expect(fileLoadedFor(loaded, { platform: "TIKTOK", slot: "NIGHT", dateISO: day })).toBe(false);
    expect(fileLoadedFor(loaded, { platform: "TIKTOK", slot: "EARLY AM", dateISO: day })).toBe(false);
  });

  it("one eBay file covers every eBay show that day", () => {
    const loaded = new Set([`EBAY||${day}`]);
    expect(fileLoadedFor(loaded, { platform: "EBAY", slot: "DAY", dateISO: day })).toBe(true);
    expect(fileLoadedFor(loaded, { platform: "EBAY", slot: "NIGHT", dateISO: day })).toBe(true);
    expect(fileLoadedFor(loaded, { platform: "TIKTOK", slot: "DAY", dateISO: day })).toBe(false);
  });

  it("an upload from before the checklist covers the whole day", () => {
    const loaded = new Set([`*||${day}`]);
    expect(fileLoadedFor(loaded, { platform: "TIKTOK", slot: "NIGHT", dateISO: day })).toBe(true);
    expect(fileLoadedFor(loaded, { platform: "EBAY", slot: "DAY", dateISO: day })).toBe(true);
  });

  it("another day's file covers nothing", () => {
    const loaded = new Set([`TIKTOK|NIGHT|2026-10-19`]);
    expect(fileLoadedFor(loaded, { platform: "TIKTOK", slot: "NIGHT", dateISO: day })).toBe(false);
  });
});

describe("margin per seller (review 10/21: profitability in Seller insights)", () => {
  const costed = (people: string[], revenue: number, cogs: number, over: Partial<SellerShow> = {}) =>
    show({ people, revenue, costedRevenueCents: revenue, cogsCents: cogs, ...over });

  it("gross profit and margin on their shows", () => {
    const r = scoreSellers([costed(["a"], 10_000, 6_000), costed(["a"], 10_000, 7_000)]);
    const a = seller(r, "a");
    expect(a.grossProfitCents).toBe(7_000);
    expect(a.margin).toBeCloseTo(0.35, 6);
  });

  it("judged against the same kind of show: a fat-margin slot is not credit", () => {
    // Nights run 50% margins, days 20%. Nina nights at 50%, Dee days at 20%:
    // both are exactly typical.
    const r = scoreSellers([
      ...Array.from({ length: 5 }, () => costed(["nina"], 10_000, 5_000, { slot: "NIGHT" })),
      ...Array.from({ length: 5 }, () => costed(["dee"], 10_000, 8_000, { slot: "DAY" })),
    ]);
    expect(seller(r, "nina").marginVsTypical).toBeCloseTo(0, 6);
    expect(seller(r, "dee").marginVsTypical).toBeCloseTo(0, 6);
  });

  it("better than typical is positive points, worse is negative", () => {
    const r = scoreSellers([
      ...Array.from({ length: 5 }, () => costed(["good"], 10_000, 6_000)),
      ...Array.from({ length: 5 }, () => costed(["thin"], 10_000, 8_000)),
    ]);
    // Typical night: 30%. Good sells at 40% (+10 pts), thin at 20% (−10 pts).
    expect(seller(r, "good").marginVsTypical).toBeCloseTo(10, 6);
    expect(seller(r, "thin").marginVsTypical).toBeCloseTo(-10, 6);
  });

  it("no cost to be had (diamonds) means no margin, not zero", () => {
    const r = scoreSellers([show({ revenue: 10_000, people: ["d"] })]);
    expect(seller(r, "d")).toMatchObject({ grossProfitCents: null, margin: null, marginVsTypical: null });
  });

  it("both people on a show share its margin", () => {
    const r = scoreSellers([costed(["p", "q"], 10_000, 6_000)]);
    expect(seller(r, "p").grossProfitCents).toBe(4_000);
    expect(seller(r, "q").grossProfitCents).toBe(4_000);
  });
});

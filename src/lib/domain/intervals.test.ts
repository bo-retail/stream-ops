import { describe, expect, it } from "vitest";
import {
  contains,
  coveredMinutes,
  durationMinutes,
  findOverlaps,
  gaps,
  intersect,
  merge,
  outsideOf,
  overlaps,
  subtract,
  summarise,
  totalMinutes,
} from "./intervals";
import type { Interval } from "./intervals";

/** Builds an interval from wall-clock hours, for readable tests. */
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 20, h, m)).getTime();
const iv = (startH: number, endH: number, startM = 0, endM = 0): Interval => ({
  start: at(startH, startM),
  end: at(endH, endM),
});

describe("duration", () => {
  it("measures minutes", () => {
    expect(durationMinutes(iv(11, 15))).toBe(240);
    expect(durationMinutes(iv(11, 11, 0, 30))).toBe(30);
  });

  it("treats an inverted or empty interval as zero", () => {
    expect(durationMinutes(iv(15, 11))).toBe(0);
    expect(durationMinutes(iv(11, 11))).toBe(0);
  });

  it("sums a set", () => {
    expect(totalMinutes([iv(11, 13), iv(19, 23)])).toBe(360);
    expect(totalMinutes([])).toBe(0);
  });
});

describe("overlaps", () => {
  it("detects a genuine clash", () => {
    expect(overlaps(iv(11, 15), iv(14, 18))).toBe(true);
    expect(overlaps(iv(11, 15), iv(12, 13))).toBe(true);
  });

  it("treats a handover as no clash", () => {
    // This is the whole point: one streamer finishing as another starts.
    expect(overlaps(iv(11, 15), iv(15, 17))).toBe(false);
    expect(overlaps(iv(15, 17), iv(11, 15))).toBe(false);
  });

  it("returns false for separated intervals", () => {
    expect(overlaps(iv(11, 13), iv(19, 23))).toBe(false);
  });

  it("is symmetric", () => {
    expect(overlaps(iv(11, 15), iv(14, 18))).toBe(overlaps(iv(14, 18), iv(11, 15)));
  });
});

describe("contains", () => {
  it("recognises a shift sitting inside offered hours", () => {
    expect(contains(iv(9, 18), iv(11, 15))).toBe(true);
    expect(contains(iv(11, 15), iv(11, 15))).toBe(true);
  });

  it("rejects a shift poking outside", () => {
    expect(contains(iv(11, 15), iv(11, 16))).toBe(false);
    expect(contains(iv(11, 15), iv(10, 15))).toBe(false);
  });
});

describe("merge", () => {
  it("joins overlapping stretches", () => {
    expect(merge([iv(11, 15), iv(14, 18)])).toEqual([iv(11, 18)]);
  });

  it("joins stretches that merely touch", () => {
    // Two people back to back is continuous coverage, not two separate blocks.
    expect(merge([iv(11, 15), iv(15, 17)])).toEqual([iv(11, 17)]);
  });

  it("keeps genuinely separate stretches apart", () => {
    expect(merge([iv(11, 15), iv(19, 23)])).toEqual([iv(11, 15), iv(19, 23)]);
  });

  it("absorbs an interval wholly inside another", () => {
    expect(merge([iv(11, 18), iv(13, 14)])).toEqual([iv(11, 18)]);
  });

  it("is unaffected by input order", () => {
    expect(merge([iv(19, 23), iv(11, 15), iv(14, 16)])).toEqual([iv(11, 16), iv(19, 23)]);
  });

  it("drops empty and inverted intervals", () => {
    expect(merge([iv(11, 11), iv(15, 12)])).toEqual([]);
    expect(merge([])).toEqual([]);
  });
});

describe("subtract", () => {
  it("returns the whole base when nothing covers it", () => {
    expect(subtract(iv(11, 17), [])).toEqual([iv(11, 17)]);
    expect(subtract(iv(11, 17), [iv(19, 23)])).toEqual([iv(11, 17)]);
  });

  it("returns nothing when fully covered", () => {
    expect(subtract(iv(11, 17), [iv(11, 17)])).toEqual([]);
    expect(subtract(iv(11, 17), [iv(9, 20)])).toEqual([]);
  });

  it("finds a hole in the middle", () => {
    // Covered 11–13 and 15–17, so 13–15 is uncovered.
    expect(subtract(iv(11, 17), [iv(11, 13), iv(15, 17)])).toEqual([iv(13, 15)]);
  });

  it("finds a hole at the start and at the end", () => {
    expect(subtract(iv(11, 17), [iv(13, 15)])).toEqual([iv(11, 13), iv(15, 17)]);
  });

  it("closes the hole when two shifts hand over", () => {
    expect(subtract(iv(11, 17), [iv(11, 15), iv(15, 17)])).toEqual([]);
  });

  it("ignores cover outside the base", () => {
    expect(subtract(iv(11, 13), [iv(9, 11), iv(13, 15)])).toEqual([iv(11, 13)]);
  });
});

describe("gaps", () => {
  it("reports the uncovered parts across several requirements", () => {
    const required = [iv(11, 15), iv(19, 23)];
    const covered = [iv(11, 15), iv(19, 21)];
    expect(gaps(required, covered)).toEqual([iv(21, 23)]);
  });

  it("reports everything when nobody is scheduled", () => {
    expect(gaps([iv(11, 15)], [])).toEqual([iv(11, 15)]);
  });

  it("reports nothing when fully staffed", () => {
    expect(gaps([iv(11, 15)], [iv(11, 13), iv(13, 15)])).toEqual([]);
  });

  it("ignores shifts scheduled outside any requirement", () => {
    expect(gaps([iv(11, 13)], [iv(19, 23)])).toEqual([iv(11, 13)]);
  });
});

describe("intersect", () => {
  it("returns the shared part", () => {
    expect(intersect(iv(11, 15), iv(13, 18))).toEqual(iv(13, 15));
  });

  it("returns null when they only touch or do not meet", () => {
    expect(intersect(iv(11, 15), iv(15, 18))).toBeNull();
    expect(intersect(iv(11, 13), iv(19, 23))).toBeNull();
  });
});

describe("outsideOf", () => {
  it("finds the part of a shift beyond what someone offered", () => {
    // Offered 11–15, scheduled 13–17: the 15–17 stretch is outside.
    expect(outsideOf(iv(13, 17), [iv(11, 15)])).toEqual([iv(15, 17)]);
  });

  it("returns nothing when the shift sits inside the offer", () => {
    expect(outsideOf(iv(12, 14), [iv(11, 15)])).toEqual([]);
  });

  it("returns the whole shift when nothing was offered", () => {
    expect(outsideOf(iv(12, 14), [])).toEqual([iv(12, 14)]);
  });

  it("stitches together two separate offered windows", () => {
    expect(outsideOf(iv(11, 17), [iv(11, 13), iv(13, 17)])).toEqual([]);
  });
});

describe("findOverlaps", () => {
  const shift = (id: string, s: number, e: number) => ({ id, interval: iv(s, e) });
  const get = (x: { interval: Interval }) => x.interval;

  it("finds a clashing pair", () => {
    const pairs = findOverlaps([shift("a", 11, 15), shift("b", 14, 18)], get);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].a.id, pairs[0].b.id].sort()).toEqual(["a", "b"]);
  });

  it("does not flag a handover", () => {
    expect(findOverlaps([shift("a", 11, 15), shift("b", 15, 19)], get)).toEqual([]);
  });

  it("finds every clashing pair among three", () => {
    expect(findOverlaps([shift("a", 11, 18), shift("b", 12, 14), shift("c", 13, 20)], get)).toHaveLength(3);
  });

  it("handles an empty or single set", () => {
    expect(findOverlaps([], get)).toEqual([]);
    expect(findOverlaps([shift("a", 11, 15)], get)).toEqual([]);
  });

  it("is unaffected by input order", () => {
    const a = findOverlaps([shift("a", 11, 15), shift("b", 14, 18)], get).length;
    const b = findOverlaps([shift("b", 14, 18), shift("a", 11, 15)], get).length;
    expect(a).toBe(b);
  });
});

describe("coveredMinutes and summarise", () => {
  it("counts only the covered part of a requirement", () => {
    expect(coveredMinutes([iv(11, 17)], [iv(11, 13)])).toBe(120);
  });

  it("does not double-count two people on at once", () => {
    // Two streamers both on 11–13 still only covers two hours of requirement.
    expect(coveredMinutes([iv(11, 13)], [iv(11, 13), iv(11, 13)])).toBe(120);
  });

  it("ignores time worked outside the requirement", () => {
    expect(coveredMinutes([iv(11, 13)], [iv(9, 20)])).toBe(120);
  });

  it("summarises a partly-staffed day", () => {
    const s = summarise([iv(11, 17)], [iv(11, 13), iv(15, 17)]);
    expect(s.requiredMinutes).toBe(360);
    expect(s.coveredMinutes).toBe(240);
    expect(s.gaps).toEqual([iv(13, 15)]);
    expect(s.ratio).toBeCloseTo(2 / 3, 6);
  });

  it("treats no requirement as fully covered rather than dividing by zero", () => {
    const s = summarise([], [iv(11, 13)]);
    expect(s.requiredMinutes).toBe(0);
    expect(s.ratio).toBe(1);
    expect(s.gaps).toEqual([]);
  });

  it("reports a fully staffed requirement as complete", () => {
    const s = summarise([iv(11, 17)], [iv(11, 15), iv(15, 17)]);
    expect(s.ratio).toBe(1);
    expect(s.gaps).toEqual([]);
  });
});

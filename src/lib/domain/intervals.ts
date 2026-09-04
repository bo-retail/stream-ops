/**
 * Interval arithmetic — the heart of a time-based schedule.
 *
 * Everything the schedule needs to know reduces to questions about stretches of
 * time: is any of this requirement uncovered, do these two shifts overlap, how
 * many hours does that add up to, is this shift inside what the person offered?
 *
 * Intervals are half-open, `[start, end)`. A shift ending at 15:00 and one
 * starting at 15:00 do not overlap — that is a handover, not a clash, and
 * getting this wrong would flag every relief shift as a conflict.
 *
 * Times are epoch milliseconds. Converting wall-clock to instants happens once,
 * at the edge, so DST is handled before any of this runs.
 */

export interface Interval {
  start: number;
  end: number;
}

export function toInterval(startsAt: Date, endsAt: Date): Interval {
  return { start: startsAt.getTime(), end: endsAt.getTime() };
}

export function durationMinutes(interval: Interval): number {
  return Math.max(0, Math.round((interval.end - interval.start) / 60_000));
}

export function totalMinutes(intervals: Interval[]): number {
  return intervals.reduce((sum, i) => sum + durationMinutes(i), 0);
}

/** Half-open overlap: touching end-to-start is not an overlap. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * Merges overlapping and touching intervals into the smallest equivalent set.
 *
 * Touching intervals are merged (11:00–13:00 and 13:00–15:00 become
 * 11:00–15:00) because for coverage purposes that is one continuous stretch
 * with nobody missing in the middle.
 */
export function merge(intervals: Interval[]): Interval[] {
  const valid = intervals.filter((i) => i.end > i.start);
  if (valid.length === 0) return [];

  const sorted = [...valid].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [{ ...sorted[0] }];

  for (const current of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/** The parts of `base` not covered by any interval in `cover`. */
export function subtract(base: Interval, cover: Interval[]): Interval[] {
  if (base.end <= base.start) return [];

  const relevant = merge(cover).filter((c) => overlaps(c, base));
  const gaps: Interval[] = [];
  let cursor = base.start;

  for (const c of relevant) {
    if (c.start > cursor) gaps.push({ start: cursor, end: Math.min(c.start, base.end) });
    cursor = Math.max(cursor, c.end);
    if (cursor >= base.end) break;
  }
  if (cursor < base.end) gaps.push({ start: cursor, end: base.end });

  return gaps.filter((g) => g.end > g.start);
}

/** Every uncovered stretch across a set of requirements. */
export function gaps(required: Interval[], covered: Interval[]): Interval[] {
  return merge(required).flatMap((r) => subtract(r, covered));
}

/** The overlapping part of two intervals, or null when they do not overlap. */
export function intersect(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

/** How much of `inner` falls outside every interval in `allowed`. */
export function outsideOf(inner: Interval, allowed: Interval[]): Interval[] {
  return subtract(inner, allowed);
}

export interface OverlapPair<T> {
  a: T;
  b: T;
}

/**
 * Every pair in a set whose intervals overlap.
 *
 * Sorted first so the scan can stop early: once a later item starts after the
 * current one ends, nothing further can overlap it.
 */
export function findOverlaps<T>(items: T[], get: (item: T) => Interval): OverlapPair<T>[] {
  const sorted = [...items].sort((x, y) => get(x).start - get(y).start);
  const pairs: OverlapPair<T>[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const a = get(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      const b = get(sorted[j]);
      if (b.start >= a.end) break;
      if (overlaps(a, b)) pairs.push({ a: sorted[i], b: sorted[j] });
    }
  }
  return pairs;
}

/** How many minutes of `required` are actually covered. */
export function coveredMinutes(required: Interval[], covered: Interval[]): number {
  const need = merge(required);
  const have = merge(covered);
  let total = 0;
  for (const r of need) {
    for (const c of have) {
      const hit = intersect(r, c);
      if (hit) total += durationMinutes(hit);
    }
  }
  return total;
}

export interface CoverageSummary {
  requiredMinutes: number;
  coveredMinutes: number;
  gaps: Interval[];
  /** 0–1. A requirement of zero minutes counts as fully covered. */
  ratio: number;
}

export function summarise(required: Interval[], covered: Interval[]): CoverageSummary {
  const requiredMinutes = totalMinutes(merge(required));
  const covered_ = coveredMinutes(required, covered);
  return {
    requiredMinutes,
    coveredMinutes: covered_,
    gaps: gaps(required, covered),
    ratio: requiredMinutes === 0 ? 1 : covered_ / requiredMinutes,
  };
}

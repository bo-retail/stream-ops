/**
 * The arithmetic behind the sales figures.
 *
 * Pure, because growth comparisons are quietly easy to get wrong — a period
 * compared against the wrong length, a percentage against zero, a "down" that
 * is really "we have not loaded yesterday yet" — and every one of those errors
 * looks like a plausible number rather than a mistake.
 */

import { addDays, diffDays } from "./dates";
import type { DateISO } from "./types";

export type Direction = "up" | "down" | "flat" | "new" | "none";

export interface Change {
  current: number;
  previous: number;
  /** Percentage change, or null when there is nothing to compare against. */
  percent: number | null;
  direction: Direction;
}

/**
 * How this period compares with the one before it.
 *
 * Zero is the awkward case and it is deliberately not a percentage. Going from
 * nothing to something is not "infinity per cent up", it is new — and going
 * from something to nothing is a total stop, which deserves its own word
 * rather than "-100%" buried among ordinary movements.
 */
export function change(current: number, previous: number): Change {
  if (previous === 0 && current === 0) {
    return { current, previous, percent: null, direction: "none" };
  }
  if (previous === 0) {
    return { current, previous, percent: null, direction: "new" };
  }

  const percent = ((current - previous) / previous) * 100;
  // Under a tenth of a percent is noise, not movement.
  const direction = Math.abs(percent) < 0.1 ? "flat" : percent > 0 ? "up" : "down";
  return { current, previous, percent, direction };
}

/** How a change should read: "+12.4%", "−8.1%", "new", "—". */
export function formatChange(c: Change): string {
  if (c.direction === "new") return "new";
  if (c.direction === "none") return "—";
  if (c.percent === null) return "—";
  if (c.direction === "flat") return "level";
  const rounded = Math.abs(c.percent) >= 10 ? Math.round(c.percent) : Math.round(c.percent * 10) / 10;
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}%`;
}

/**
 * The stretch immediately before this one, of exactly the same length.
 *
 * Same length, not "the previous calendar month": comparing 31 days against 28
 * makes February look like a catastrophe every year. Immediately before, so
 * nothing falls in the gap between them.
 */
export function previousRange(from: DateISO, to: DateISO): { from: DateISO; to: DateISO } {
  const lengthDays = diffDays(from, to) + 1;
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(lengthDays - 1)), to: prevTo };
}

/** Whole cents to pounds-and-pence as a number, for display and for a chart. */
export const fromCents = (cents: number): number => Math.round(cents) / 100;

export function formatMoney(cents: number): string {
  return `$${fromCents(cents).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Money without the pennies, for headline figures where they only add noise. */
export function formatMoneyShort(cents: number): string {
  const value = fromCents(cents);
  if (Math.abs(value) >= 10_000) return `$${Math.round(value / 1000)}k`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * A model is hot when it keeps selling, not when it sold once.
 *
 * The threshold moves with the catalogue rather than being a number typed here:
 * against a busy fortnight a fixed "ten or more" marks everything, and against
 * a quiet one it marks nothing. The top tenth by units always means the same
 * thing — these are the ones worth restocking.
 *
 * A floor of three stops a slow week crowning something that sold twice.
 */
export function hotThreshold(unitsPerModel: readonly number[]): number {
  if (unitsPerModel.length === 0) return Infinity;
  const sorted = [...unitsPerModel].sort((a, b) => b - a);
  // Rounded up and stepped back one, so twenty models mark two rather than
  // three, and a short list still marks its best seller rather than nobody.
  const index = Math.max(0, Math.ceil(sorted.length * 0.1) - 1);
  return Math.max(3, sorted[index]);
}

export interface Trend {
  dateISO: DateISO;
  value: number;
}

/**
 * A simple average over the last `window` points, for a trend line that is
 * readable rather than a saw.
 *
 * Day-to-day sales swing enormously — a day with two shows against a day with
 * four — and the raw line says nothing except that some days are busier. The
 * bars keep the truth; this rides over them.
 */
export function movingAverage(points: readonly Trend[], window: number): Trend[] {
  if (window <= 1) return [...points];
  return points.map((point, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = points.slice(start, i + 1);
    return {
      dateISO: point.dateISO,
      value: slice.reduce((sum, p) => sum + p.value, 0) / slice.length,
    };
  });
}

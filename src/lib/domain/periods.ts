/**
 * Scheduling periods: the 1st to the 15th, and the 16th to the end of the month.
 *
 * The schedule is built and released in these blocks rather than in Monday-to-
 * Sunday weeks, so the dates on a rota line up exactly with the dates on a pay
 * run. A week that straddles the 15th would otherwise have to be split by hand
 * every time.
 *
 * Periods are derived from the calendar, never stored, so there is exactly one
 * answer to "which period does this date belong to".
 */

import { addDays, assertDateISO } from "./dates";
import type { DateISO } from "./types";

export interface Period {
  /** First day: the 1st or the 16th. */
  start: DateISO;
  /** Last day: the 15th, or the last day of the month. */
  end: DateISO;
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parts(dateISO: DateISO) {
  const [year, month, day] = assertDateISO(dateISO).split("-").map(Number);
  return { year, month, day };
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (year: number, month: number, day: number) =>
  `${year}-${pad(month)}-${pad(day)}`;

/** Days in a month. Handles leap years, because February will not handle itself. */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The period containing a date. */
export function periodFor(dateISO: DateISO): Period {
  const { year, month, day } = parts(dateISO);
  return day <= 15
    ? { start: iso(year, month, 1), end: iso(year, month, 15) }
    : { start: iso(year, month, 16), end: iso(year, month, lastDayOfMonth(year, month)) };
}

/** The period after this one — the second half of the same month, or the first of the next. */
export function nextPeriod(period: Period): Period {
  return periodFor(addDays(period.end, 1));
}

export function previousPeriod(period: Period): Period {
  return periodFor(addDays(period.start, -1));
}

/** Every date in a period, in order. 15 or 13–16 days depending on the half. */
export function periodDates(period: Period): DateISO[] {
  const dates: DateISO[] = [];
  let current = period.start;
  while (current <= period.end) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

export function periodLength(period: Period): number {
  return periodDates(period).length;
}

/** True when the date is the first day of a period — the 1st or the 16th. */
export function isPeriodStart(dateISO: DateISO): boolean {
  const { day } = parts(dateISO);
  return day === 1 || day === 16;
}

/** Normalises any date to the first day of its period. */
export function periodStart(dateISO: DateISO): DateISO {
  return periodFor(dateISO).start;
}

/**
 * `count` periods starting from the one containing `dateISO`, going forward.
 * Used for releasing availability several periods ahead.
 */
export function upcomingPeriods(dateISO: DateISO, count: number): Period[] {
  const periods: Period[] = [];
  let current = periodFor(dateISO);
  for (let i = 0; i < count; i++) {
    periods.push(current);
    current = nextPeriod(current);
  }
  return periods;
}

/** `count` periods ending with the one containing `dateISO`, newest first. */
export function recentPeriods(dateISO: DateISO, count: number): Period[] {
  const periods: Period[] = [];
  let current = periodFor(dateISO);
  for (let i = 0; i < count; i++) {
    periods.push(current);
    current = previousPeriod(current);
  }
  return periods;
}

/** "1–15 September 2026" / "16–30 September 2026". */
export function formatPeriod(period: Period): string {
  const from = parts(period.start);
  const to = parts(period.end);
  return `${from.day}–${to.day} ${MONTH_NAMES[from.month - 1]} ${from.year}`;
}

/** "Sep 1–15" — for tabs and buttons where space is tight. */
export function formatPeriodShort(period: Period): string {
  const from = parts(period.start);
  const to = parts(period.end);
  return `${MONTH_NAMES[from.month - 1].slice(0, 3)} ${from.day}–${to.day}`;
}

/** "First half" / "Second half", for when the month is already on screen. */
export function periodHalf(period: Period): string {
  return parts(period.start).day === 1 ? "First half" : "Second half";
}

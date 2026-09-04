/**
 * Calendar math.
 *
 * Business dates are handled as `YYYY-MM-DD` strings, not `Date` objects. A
 * `Date` carries an instant, and every time one is used to mean "Tuesday the
 * 14th" someone eventually reads it in the wrong zone and the whole week shifts
 * by a day. Strings cannot drift.
 *
 * Real instants (when a show actually starts) are computed only where they are
 * genuinely needed — overlap detection and paid duration — and are always
 * derived through the configured business time zone so DST is handled correctly.
 */

import { TZDate } from "@date-fns/tz";
import type { DateISO, TimeHM } from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isDateISO(value: string): value is DateISO {
  return DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

export function assertDateISO(value: string): DateISO {
  if (!isDateISO(value)) throw new Error(`Invalid date: ${value}`);
  return value;
}

export function isTimeHM(value: string): value is TimeHM {
  return TIME_RE.test(value);
}

/** `YYYY-MM-DD` -> the UTC-midnight `Date` used for Postgres `date` columns. */
export function toDbDate(dateISO: DateISO): Date {
  return new Date(`${assertDateISO(dateISO)}T00:00:00.000Z`);
}

/** Inverse of {@link toDbDate}. */
export function fromDbDate(date: Date): DateISO {
  return date.toISOString().slice(0, 10);
}

export function addDays(dateISO: DateISO, days: number): DateISO {
  const d = toDbDate(dateISO);
  d.setUTCDate(d.getUTCDate() + days);
  return fromDbDate(d);
}

/** Whole days from `a` to `b`; negative when `b` precedes `a`. */
export function diffDays(a: DateISO, b: DateISO): number {
  return Math.round((toDbDate(b).getTime() - toDbDate(a).getTime()) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(dateISO: DateISO): number {
  return toDbDate(dateISO).getUTCDay();
}

/** The Monday of the week containing `dateISO`. Weeks run Monday–Sunday. */
export function weekStart(dateISO: DateISO): DateISO {
  const dow = dayOfWeek(dateISO);
  return addDays(dateISO, dow === 0 ? -6 : 1 - dow);
}

export function weekEnd(dateISO: DateISO): DateISO {
  return addDays(weekStart(dateISO), 6);
}

/** The seven dates of the week beginning at `weekStartISO`, Monday first. */
export function weekDates(weekStartISO: DateISO): DateISO[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStartISO, i));
}

/** "Today" as a business date in the configured zone. */
export function todayISO(timezone: string, now: Date = new Date()): DateISO {
  const tz = new TZDate(now.getTime(), timezone);
  return `${tz.getFullYear()}-${pad(tz.getMonth() + 1)}-${pad(tz.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatDate(dateISO: DateISO, style: "long" | "medium" | "short" = "medium"): string {
  const d = toDbDate(dateISO);
  const wd = WEEKDAYS[d.getUTCDay()];
  const mo = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  if (style === "long") return `${wd}, ${mo} ${day}, ${year}`;
  if (style === "short") return `${mo.slice(0, 3)} ${day}`;
  return `${wd.slice(0, 3)} ${mo.slice(0, 3)} ${day}`;
}

/**
 * Every date from start to end inclusive.
 *
 * A release covers whatever range the boss picked, so the day list cannot be
 * derived from a rule the way a fixed fortnight's could.
 */
export function datesBetween(startISO: DateISO, endISO: DateISO): DateISO[] {
  const out: DateISO[] = [];
  for (let d = startISO; d <= endISO; d = addDays(d, 1)) out.push(d);
  return out;
}

export function formatDateRange(startISO: DateISO, endISO: DateISO): string {
  const a = toDbDate(startISO);
  const b = toDbDate(endISO);
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const left = `${MONTHS[a.getUTCMonth()].slice(0, 3)} ${a.getUTCDate()}${sameYear ? "" : `, ${a.getUTCFullYear()}`}`;
  const right = `${MONTHS[b.getUTCMonth()].slice(0, 3)} ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
  return `${left} – ${right}`;
}

/** `"19:00"` -> `"7:00 PM"`. */
export function formatTimeHM(time: TimeHM): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${pad(m)} ${suffix}`;
}

export interface SlotInstants {
  startsAt: Date;
  endsAt: Date;
  /** Actual elapsed paid time in hundredths of an hour. */
  hoursHundredths: number;
  /** True when the show runs past midnight into the following day. */
  crossesMidnight: boolean;
}

/**
 * Resolves a wall-clock show window on a given business date into real instants.
 *
 * An end time at or before the start time means the show runs past midnight.
 * Elapsed hours are measured between the resolved instants, so a shift crossing
 * a DST boundary is paid for the time actually worked rather than the nominal
 * clock difference.
 */
export function resolveSlotInstants(
  dateISO: DateISO,
  start: TimeHM,
  end: TimeHM,
  timezone: string,
): SlotInstants {
  if (!isTimeHM(start) || !isTimeHM(end)) {
    throw new Error(`Invalid show time: ${start}–${end}`);
  }
  const [y, mo, d] = assertDateISO(dateISO).split("-").map(Number);
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);

  const crossesMidnight = eh * 60 + em <= sh * 60 + sm;
  const endDate = crossesMidnight ? addDays(dateISO, 1) : dateISO;
  const [ey, emo, ed] = endDate.split("-").map(Number);

  const startsAt = new Date(new TZDate(y, mo - 1, d, sh, sm, 0, 0, timezone).getTime());
  const endsAt = new Date(new TZDate(ey, emo - 1, ed, eh, em, 0, 0, timezone).getTime());

  const hoursHundredths = Math.round(((endsAt.getTime() - startsAt.getTime()) / 3_600_000) * 100);
  return { startsAt, endsAt, hoursHundredths, crossesMidnight };
}

/** Formats a duration in minutes as a short human string: 150 -> "2h 30m". */
export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "0h";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Decimal hours, for totals: 150 -> "2.5". */
export function minutesToHours(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0$/, "");
}

/** Half-open overlap test: shows that merely touch end-to-start do not overlap. */
export function instantsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

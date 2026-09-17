/**
 * How clocked time becomes paid time.
 *
 * A streamer's hours are measured against the show they were on:
 *
 *   Clocked in early    → the shift start counts. Turning up twenty minutes
 *                         before the show does not start the clock early.
 *   Clocked in late     → the clock-in counts. Lateness comes off.
 *   Clocked out early   → the clock-out counts. Leaving early comes off.
 *   Clocked out late    → the shift end counts. Staying behind afterwards does
 *                         not extend the shift.
 *
 * Which is the overlap of the two windows: start at whichever is later, finish
 * at whichever is earlier.
 *
 * Shipping has no schedule, so their raw times are their paid times. So is any
 * streamer entry with no show attached — someone who clocked in when they were
 * not on anything is a question for the boss, not something to silently zero.
 *
 * The raw clock times are never altered anywhere. This only decides what to
 * count, so the audit can always show both what happened and what was paid.
 */

/**
 * Whether the show an entry is attached to also bounds what it pays.
 *
 * Deliberately separate from "does this entry have a show", which is answered
 * by whether there is one. Those two were once the same expression, and the
 * result was that every schedule-printed row on the Payroll screen read "No
 * scheduled show" — the one case where the show is certain. The hours were
 * always right; only the label lied. Keeping the pay rule in its own named
 * function is what stops them being merged again by somebody tidying up.
 *
 * Only a self-clocked entry is clamped. Clamping answers "they turned up
 * twenty minutes early, do we pay it", which is a question that only arises
 * when somebody pressed a button. A SCHEDULE entry's times *are* the shift, so
 * clamping it is a no-op until the boss corrects one — at which point it would
 * quietly undo the correction. An ADMIN entry was typed deliberately, with a
 * reason.
 *
 * A cancelled show is not a shift anybody was meant to work, so it stops
 * bounding the hours: whatever they actually clocked stands.
 */
export function showClampsPay(
  source: "SELF" | "ADMIN" | "SCHEDULE",
  showStatus: "SCHEDULED" | "CANCELLED" | null,
): boolean {
  return source === "SELF" && showStatus === "SCHEDULED";
}

export interface ClockWindow {
  clockInAt: Date;
  /** Null while the person is still clocked in. */
  clockOutAt: Date | null;
}

export interface ShiftWindow {
  startsAt: Date;
  endsAt: Date;
}

export interface PaidWindow {
  /** When the paid time starts. */
  from: Date;
  /** When it ends. Null while the person is still clocked in. */
  to: Date | null;
  minutes: number | null;
  /** True when the shift bounded the time rather than the clock. */
  clamped: boolean;
  /** Minutes lost by clocking in after the show had started. */
  lateMinutes: number;
  /** Minutes lost by clocking out before the show ended. */
  leftEarlyMinutes: number;
  /** Minutes worked outside the shift that are not paid. */
  unpaidMinutes: number;
}

const MS_PER_MINUTE = 60_000;

const minutesBetween = (from: Date, to: Date) =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / MS_PER_MINUTE));

/**
 * The paid window for one entry.
 *
 * `shift` null means nothing to measure against — shipping, or a streamer who
 * clocked in outside any show — and the raw times stand.
 */
export function paidWindow(clock: ClockWindow, shift: ShiftWindow | null): PaidWindow {
  if (!shift) {
    return {
      from: clock.clockInAt,
      to: clock.clockOutAt,
      minutes: clock.clockOutAt ? minutesBetween(clock.clockInAt, clock.clockOutAt) : null,
      clamped: false,
      lateMinutes: 0,
      leftEarlyMinutes: 0,
      unpaidMinutes: 0,
    };
  }

  // Start at whichever is later, finish at whichever is earlier.
  const from = clock.clockInAt > shift.startsAt ? clock.clockInAt : shift.startsAt;
  const to =
    clock.clockOutAt === null
      ? null
      : clock.clockOutAt < shift.endsAt
        ? clock.clockOutAt
        : shift.endsAt;

  const lateMinutes =
    clock.clockInAt > shift.startsAt ? minutesBetween(shift.startsAt, clock.clockInAt) : 0;
  const leftEarlyMinutes =
    clock.clockOutAt !== null && clock.clockOutAt < shift.endsAt
      ? minutesBetween(clock.clockOutAt, shift.endsAt)
      : 0;

  // Somebody who clocked in after the show ended, or out before it started, has
  // no overlap at all. minutesBetween floors at zero, but `to` can still read as
  // earlier than `from`, so the window is collapsed rather than left inverted.
  const noOverlap = to !== null && to <= from;

  const rawMinutes = clock.clockOutAt ? minutesBetween(clock.clockInAt, clock.clockOutAt) : null;
  const paidMinutes = to === null ? null : noOverlap ? 0 : minutesBetween(from, to);

  return {
    from,
    // With no overlap the window is collapsed onto its start rather than left
    // reading backwards.
    to: noOverlap ? from : to,
    minutes: paidMinutes,
    clamped:
      clock.clockInAt < shift.startsAt ||
      (clock.clockOutAt !== null && clock.clockOutAt > shift.endsAt),
    lateMinutes,
    leftEarlyMinutes,
    unpaidMinutes: rawMinutes === null || paidMinutes === null ? 0 : Math.max(0, rawMinutes - paidMinutes),
  };
}

/**
 * Picks the show a clock-in belongs to.
 *
 * The one whose hours are nearest the moment somebody clocked in — the show they
 * are turning up for. A shift already finished hours ago, or not starting until
 * tomorrow, is not it, so anything further than `windowHours` away is ignored
 * and the entry stands on its raw times instead of being wrongly clamped.
 */
export function showForClockIn<T extends ShiftWindow>(
  clockInAt: Date,
  shifts: T[],
  windowHours = 6,
): T | null {
  const limit = windowHours * 60 * MS_PER_MINUTE;
  let best: { shift: T; distance: number } | null = null;

  for (const shift of shifts) {
    const at = clockInAt.getTime();
    // Zero while inside the shift; otherwise how far outside it.
    const distance =
      at < shift.startsAt.getTime()
        ? shift.startsAt.getTime() - at
        : at > shift.endsAt.getTime()
          ? at - shift.endsAt.getTime()
          : 0;

    if (distance > limit) continue;
    if (!best || distance < best.distance) best = { shift, distance };
  }

  return best?.shift ?? null;
}

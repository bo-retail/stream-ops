/**
 * Who gets a seat when more than one person could take it.
 *
 * The rules, in the order they are applied:
 *
 *   1. Fill as many seats as possible. This is not a tie-break but the shape of
 *      the whole thing: a person is only ever a candidate if putting them in
 *      creates no problem, and a seat is left empty rather than filled with
 *      somebody who cannot work it.
 *   2. Priority people first — if this release turns that on. The boss names
 *      them when he builds the release, not once in a settings page.
 *   3. Whoever has used the least of their own availability — if this release
 *      turns that on. Work is handed out in proportion to how much each person
 *      offered, so somebody available for thirty shows ends up with roughly
 *      three times as many as somebody available for ten, without a part-timer
 *      who turned up ending the period on nothing.
 *   4. Fewest shows so far, then name, so the result is stable and even.
 *
 * Rules 2 and 3 are switches, off or on per release. Rules 1 and 4 are not:
 * one is the whole point, and the other is what is left when the switches are
 * off — somebody has to get the seat, and the fairest answer is whoever has
 * least.
 *
 * Nobody is ever assigned to a show they did not offer. That is enforced by the
 * caller building the candidate list, and asserted by the tests here.
 */

import type { DateISO } from "./types";

export interface Candidate {
  userId: string;
  name: string;
  /** Higher goes first. 0 is normal; the boss raises it for key people. */
  priority: number;
  /** How many shows they offered across the whole period. Always at least 1 —
   *  offering this show is what made them a candidate. */
  offered: number;
  /** How many they already have. */
  assigned: number;
}

/** Which of the optional rules this release turned on. */
export interface Rules {
  /** Give the people the boss named on this release priority. */
  usePriority: boolean;
  /** Split the work in proportion to how much each person offered. */
  useProportional: boolean;
}

export const ALL_RULES_OFF: Rules = { usePriority: false, useProportional: false };

/**
 * Orders candidates for a seat. The first is the one to give it to.
 *
 * Pure and total: same input, same order, every time. Ties break on name so a
 * rebuild of the same release does not shuffle people around for no reason.
 */
export function rankCandidates(candidates: Candidate[], rules: Rules): Candidate[] {
  return [...candidates].sort((a, b) => {
    // 2. Priority people first, when this release asked for that.
    if (rules.usePriority && a.priority !== b.priority) return b.priority - a.priority;

    // 3. Whoever has used the least of their own availability, so the work is
    //    split in proportion to what each person offered.
    //
    //    Compared by cross-multiplying rather than dividing: integer maths has
    //    no rounding, so two people on the same share are always an exact tie
    //    and the order below decides, rather than a float comparison deciding
    //    it invisibly. Both denominators are at least 1, so this is safe.
    if (rules.useProportional) {
      const share = a.assigned * b.offered - b.assigned * a.offered;
      if (share !== 0) return share;
    }

    // 4. Then spread the work, then name.
    if (a.assigned !== b.assigned) return a.assigned - b.assigned;
    return a.name.localeCompare(b.name);
  });
}

/**
 * How much of their offered availability a person has been given, 0 to 1.
 *
 * Exported for display and for the tests; the ranking above compares the same
 * quantity without dividing.
 */
export function shareUsed(candidate: Candidate): number {
  if (candidate.offered <= 0) return 1;
  return candidate.assigned / candidate.offered;
}

/** Why a person cannot take a seat. Null means they can. */
export type Blocker =
  | { code: "NOT_OFFERED"; message: string }
  | { code: "DAY_OFF"; message: string }
  | { code: "ALREADY_ON_SHOW"; message: string }
  | { code: "CLASH"; message: string }
  | { code: "AT_LIMIT"; message: string };

export interface SeatContext {
  dateISO: DateISO;
  startsAt: Date;
  endsAt: Date;
  /** Everyone already on this show. */
  onThisShow: Set<string>;
  /** Every show each person is already on, for the clash check. */
  placed: { userId: string; startsAt: Date; endsAt: Date }[];
}

export interface PersonContext {
  userId: string;
  offeredThisShow: boolean;
  daysOff: DateISO[];
  assigned: number;
  maxShows: number | null;
}

/**
 * Whether a person may take a seat, and if not, the reason in plain words.
 *
 * Every one of these is a hard no. Auto-fill leaves the seat empty rather than
 * overriding any of them — an unfilled seat shows in red and gets a human
 * decision, which is the whole point.
 */
export function blockerFor(person: PersonContext, seat: SeatContext): Blocker | null {
  if (seat.onThisShow.has(person.userId)) {
    return { code: "ALREADY_ON_SHOW", message: "Already on this show" };
  }
  if (!person.offeredThisShow) {
    return { code: "NOT_OFFERED", message: "Did not offer this show" };
  }
  if (person.daysOff.includes(seat.dateISO)) {
    return { code: "DAY_OFF", message: "Booked this day off" };
  }

  const clash = seat.placed.some(
    (p) =>
      p.userId === person.userId &&
      p.startsAt.getTime() < seat.endsAt.getTime() &&
      seat.startsAt.getTime() < p.endsAt.getTime(),
  );
  if (clash) return { code: "CLASH", message: "Already on another show at that time" };

  if (person.maxShows != null && person.maxShows > 0 && person.assigned >= person.maxShows) {
    return { code: "AT_LIMIT", message: `Already on ${person.assigned} shows, at the limit` };
  }

  return null;
}

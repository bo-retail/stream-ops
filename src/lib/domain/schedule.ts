/**
 * Schedule validation.
 *
 * Answers the questions the boss needs before publishing:
 *   - is any show short a person?
 *   - is anyone booked on two shows that run at the same time?
 *   - is anyone on a show they did not offer?
 *   - is anyone on a day they booked off?
 *   - is anyone over the cap this release set?
 *
 * Only one thing blocks publishing: the same person on two shows at once. That
 * is not a judgement call — one person cannot be in two places, and publishing
 * it would tell two shows they have somebody they do not have.
 *
 * Everything else informs rather than obstructs, including a show short of a
 * person. An open seat is a real state of the world: the boss publishes what
 * they have, talks to people, and fills it afterwards. Refusing to publish
 * would not fill the seat — it would only stop the other 119 people finding out
 * when they are working.
 *
 * A cancelled show is excluded from everything. It needs nobody, and it cannot
 * clash with anything.
 */

import { instantsOverlap } from "./dates";
import { PLATFORM_SHORT, SEATS_PER_SHOW, SLOT_SHORT } from "./types";
import type { DateISO, Platform, ShowStatus, Slot } from "./types";

export interface AssignmentInput {
  id: string;
  showId: string;
  userId: string;
  userName: string;
  /** 1 or 2. Carries no meaning — the pair swap jobs halfway through. */
  seat: number;
}

export interface ShowInput {
  id: string;
  dateISO: DateISO;
  platform: Platform;
  slot: Slot;
  startsAt: Date;
  endsAt: Date;
  status: ShowStatus;
}

export interface AvailabilityInput {
  userId: string;
  dateISO: DateISO;
  slot: Slot;
}

/**
 * Somebody already on a show in a different release.
 *
 * Each release is built on its own screen, and a watch release and a diamond
 * release can cover the same days with shows at the same hours — the 09/15
 * diamond show ran 10:32–16:01 against the watch day show's 10:06–16:05. Until
 * these were passed in, every check below looked at one release only, so
 * somebody already on a published diamond show could be picked, auto-filled
 * and published onto an overlapping watch show without a word.
 *
 * `label` names the other show in full ("Diamond TikTok Day on 2026-09-20"),
 * because "already on another show" does not tell the boss where to look.
 */
export interface BookedElsewhere {
  userId: string;
  userName: string;
  label: string;
  startsAt: Date;
  endsAt: Date;
}

export type IssueCode =
  | "UNSTAFFED"
  | "DOUBLE_BOOKED"
  | "NOT_AVAILABLE"
  | "ON_TIME_OFF"
  | "OVER_MAX_SHOWS"
  | "MISSING_SUBMISSION";

export type IssueSeverity = "error" | "warning";

export interface ScheduleIssue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  dateISO?: DateISO;
  platform?: Platform;
  slot?: Slot;
  seat?: number;
  userId?: string;
  showIds: string[];
}

export interface ShowSummary {
  showId: string;
  dateISO: DateISO;
  platform: Platform;
  slot: Slot;
  status: ShowStatus;
  filled: number;
  /** How many of the two seats still need somebody. */
  empty: number;
}

export interface ScheduleValidation {
  issues: ScheduleIssue[];
  errors: ScheduleIssue[];
  warnings: ScheduleIssue[];
  canPublish: boolean;
  shows: ShowSummary[];
  /** Shows assigned per person, by user id. */
  showsByUser: Record<string, number>;
  totalSeats: number;
  filledSeats: number;
  /** Seats on live shows still needing somebody. Publishable, but worth saying. */
  openSeats: number;
}

export interface ValidateOptions {
  availability?: AvailabilityInput[];
  timeOffByUser?: Record<string, DateISO[]>;
  maxShowsPerPerson?: number | null;
  /** Users expected to submit availability, for the missing-submission warning. */
  expectedUserIds?: string[];
  submittedUserIds?: string[];
  /** Shows these people are already on in other releases. See `BookedElsewhere`. */
  elsewhere?: BookedElsewhere[];
}

/** "TikTok Day on 2026-08-21" — how a show is named in every message. */
export function showLabel(show: {
  dateISO: DateISO;
  platform: Platform;
  slot: Slot;
}): string {
  return `${PLATFORM_SHORT[show.platform]} ${SLOT_SHORT[show.slot]} on ${show.dateISO}`;
}

export function validateSchedule(
  shows: ShowInput[],
  assignments: AssignmentInput[],
  options: ValidateOptions = {},
): ScheduleValidation {
  const issues: ScheduleIssue[] = [];
  const showById = new Map(shows.map((s) => [s.id, s]));

  // Assignments pointing at a cancelled or unknown show are ignored rather than
  // reported: cancelling a show deliberately leaves its people free.
  const active = assignments.filter((a) => showById.get(a.showId)?.status === "SCHEDULED");

  const byShow = new Map<string, AssignmentInput[]>();
  for (const a of active) {
    byShow.set(a.showId, [...(byShow.get(a.showId) ?? []), a]);
  }

  /* ------------------------------------------------------- unstaffed shows */

  const summaries: ShowSummary[] = shows.map((show) => {
    const filled = byShow.get(show.id) ?? [];
    return {
      showId: show.id,
      dateISO: show.dateISO,
      platform: show.platform,
      slot: show.slot,
      status: show.status,
      filled: filled.length,
      empty: show.status === "CANCELLED" ? 0 : Math.max(0, SEATS_PER_SHOW - filled.length),
    };
  });

  for (const summary of summaries) {
    if (summary.empty === 0) continue;
    issues.push({
      code: "UNSTAFFED",
      severity: "warning",
      message:
        summary.filled === 0
          ? `${showLabel(summary)} has nobody on it — it needs two people.`
          : `${showLabel(summary)} has only one person — it needs two.`,
      dateISO: summary.dateISO,
      platform: summary.platform,
      slot: summary.slot,
      showIds: [summary.showId],
    });
  }

  /* ---------------------------------------------------------- double booked */

  const byUser = new Map<string, AssignmentInput[]>();
  for (const a of active) {
    byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), a]);
  }

  for (const [userId, theirs] of byUser) {
    const withShows = theirs
      .map((a) => ({ assignment: a, show: showById.get(a.showId)! }))
      .sort((x, y) => x.show.startsAt.getTime() - y.show.startsAt.getTime());

    for (let i = 0; i < withShows.length; i++) {
      for (let j = i + 1; j < withShows.length; j++) {
        const a = withShows[i];
        const b = withShows[j];
        // The database forbids one person taking both seats of a show, so a pair
        // on the same show cannot occur; skip rather than report it as a clash
        // with itself.
        if (a.show.id === b.show.id) continue;

        // Half-open: a night show ending at 01:00 and a day show starting at
        // 13:00 do not clash, and neither does back-to-back on one platform.
        if (!instantsOverlap(a.show.startsAt, a.show.endsAt, b.show.startsAt, b.show.endsAt)) {
          continue;
        }
        issues.push({
          code: "DOUBLE_BOOKED",
          severity: "error",
          message: `${a.assignment.userName} is on ${showLabel(a.show)} and ${showLabel(b.show)} at the same time.`,
          dateISO: a.show.dateISO,
          userId,
          showIds: [a.show.id, b.show.id],
        });
      }
    }
  }

  // The same, against shows in other releases. An error for the same reason:
  // one person cannot be on two shows at once, whichever screen each was built
  // on, and publishing it would promise both shows somebody they do not have.
  for (const a of active) {
    const show = showById.get(a.showId)!;
    for (const other of options.elsewhere ?? []) {
      if (other.userId !== a.userId) continue;
      if (!instantsOverlap(show.startsAt, show.endsAt, other.startsAt, other.endsAt)) continue;
      issues.push({
        code: "DOUBLE_BOOKED",
        severity: "error",
        message: `${a.userName} is on ${showLabel(show)} here and on ${other.label} at the same time.`,
        dateISO: show.dateISO,
        userId: a.userId,
        seat: a.seat,
        showIds: [show.id],
      });
    }
  }

  /* ------------------------------------------------ availability and time off */

  const offered = new Set(
    (options.availability ?? []).map((a) => `${a.userId}|${a.dateISO}|${a.slot}`),
  );
  const hasAnyAvailability = new Set((options.availability ?? []).map((a) => a.userId));

  for (const a of active) {
    const show = showById.get(a.showId)!;

    const daysOff = options.timeOffByUser?.[a.userId] ?? [];
    if (daysOff.includes(show.dateISO)) {
      issues.push({
        code: "ON_TIME_OFF",
        severity: "warning",
        message: `${a.userName} booked ${show.dateISO} off but is on ${showLabel(show)}.`,
        dateISO: show.dateISO,
        userId: a.userId,
        seat: a.seat,
        showIds: [show.id],
      });
    }

    // Only checked for people who submitted something. Someone who never
    // submitted gets the missing-submission warning instead, not a pile of
    // "not available" warnings for every show they are on.
    if (!hasAnyAvailability.has(a.userId)) continue;

    if (!offered.has(`${a.userId}|${show.dateISO}|${show.slot}`)) {
      issues.push({
        code: "NOT_AVAILABLE",
        severity: "warning",
        message: `${a.userName} did not offer ${showLabel(show)}.`,
        dateISO: show.dateISO,
        userId: a.userId,
        seat: a.seat,
        showIds: [show.id],
      });
    }
  }

  /* ------------------------------------------------------- the release cap */

  const showsByUser: Record<string, number> = {};
  for (const [userId, theirs] of byUser) {
    showsByUser[userId] = theirs.length;
  }

  const cap = options.maxShowsPerPerson;
  if (cap != null && cap > 0) {
    for (const [userId, theirs] of byUser) {
      if (theirs.length <= cap) continue;
      issues.push({
        code: "OVER_MAX_SHOWS",
        severity: "warning",
        message: `${theirs[0].userName} is on ${theirs.length} shows, over the limit of ${cap}.`,
        userId,
        showIds: theirs.map((a) => a.showId),
      });
    }
  }

  /* ------------------------------------------------- missing submissions */

  if (options.expectedUserIds && options.submittedUserIds) {
    const submitted = new Set(options.submittedUserIds);
    const missing = options.expectedUserIds.filter((id) => !submitted.has(id));
    if (missing.length > 0) {
      issues.push({
        code: "MISSING_SUBMISSION",
        severity: "warning",
        message: `${missing.length} ${missing.length === 1 ? "person has" : "people have"} not sent their availability yet.`,
        showIds: [],
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  const liveSummaries = summaries.filter((s) => s.status === "SCHEDULED");
  const totalSeats = liveSummaries.length * SEATS_PER_SHOW;
  const filledSeats = liveSummaries.reduce((n, s) => n + s.filled, 0);

  return {
    issues,
    errors,
    warnings,
    // A period with every show cancelled is publishable — "we are not streaming
    // this fortnight" is a real decision. A period with no shows at all is not:
    // it has simply never been set up.
    canPublish: errors.length === 0 && shows.length > 0,
    shows: summaries,
    showsByUser,
    totalSeats,
    filledSeats,
    openSeats: totalSeats - filledSeats,
  };
}

/* ------------------------------------------------- copying a release forward */

export interface CopySourceShow {
  date: Date;
  platform: Platform;
  slot: Slot;
  assignments: readonly { userId: string; seat: number }[];
}

export interface CopyTargetShow {
  id: string;
  date: Date;
  platform: Platform;
  slot: Slot;
  /** Seats already filled here. Never overwritten. */
  takenSeats: readonly number[];
}

export interface CopyPlan {
  toCreate: { showId: string; userId: string; seat: number }[];
  /** Placements dropped because that person can no longer be scheduled. */
  skipped: number;
}

/**
 * Who to put on the new release, taken from the last one.
 *
 * Matched on weekday, platform and slot rather than by date or position: a
 * release can be any length, so "the Tuesday night eBay show" is the only thing
 * that means the same in both.
 *
 * `eligible` is the people who can still be scheduled today, and it is the whole
 * point of this being a decision rather than a copy. Somebody who has left, or
 * moved onto shipping, keeps their place on the releases they actually worked —
 * those assignments are left alone on purpose, because deleting them would empty
 * seats on a rota that has already gone out. So there is always a name here to
 * find, and carrying it forward would put somebody on a schedule they cannot
 * work. They are counted rather than silently dropped, so the boss is told.
 */
export function planCopyForward(
  previous: readonly CopySourceShow[],
  current: readonly CopyTargetShow[],
  eligible: ReadonlySet<string>,
): CopyPlan {
  const key = (date: Date, platform: Platform, slot: Slot) =>
    `${date.getUTCDay()}|${platform}|${slot}`;

  // Where a weekday has more than one matching show — a three-week release
  // copying from a two-week one — the earliest is used, so the pattern repeats
  // rather than the last one winning arbitrarily.
  const byWeekday = new Map<string, readonly { userId: string; seat: number }[]>();
  for (const show of [...previous].sort((a, b) => a.date.getTime() - b.date.getTime())) {
    const k = key(show.date, show.platform, show.slot);
    if (!byWeekday.has(k)) byWeekday.set(k, show.assignments);
  }

  const toCreate: CopyPlan["toCreate"] = [];
  let skipped = 0;

  for (const show of current) {
    const taken = new Set(show.takenSeats);
    const source = byWeekday.get(key(show.date, show.platform, show.slot)) ?? [];
    for (const a of source) {
      if (taken.has(a.seat)) continue;
      if (!eligible.has(a.userId)) {
        skipped++;
        continue;
      }
      // Never both seats to one person, even if the source somehow had that.
      if (toCreate.some((c) => c.showId === show.id && c.userId === a.userId)) continue;
      toCreate.push({ showId: show.id, userId: a.userId, seat: a.seat });
    }
  }

  return { toCreate, skipped };
}

/**
 * Whether a person can be added to a show, and if not, why.
 *
 * Used to explain a disabled option in the picker rather than silently omitting
 * the person — "why can't I pick Maya?" should always have an answer on screen.
 */
export function checkCandidate(
  userId: string,
  show: ShowInput,
  options: {
    assignments: AssignmentInput[];
    shows: ShowInput[];
    availability?: AvailabilityInput[];
    timeOffByUser?: Record<string, DateISO[]>;
    /** Shows they are already on in other releases. */
    elsewhere?: BookedElsewhere[];
  },
): { ok: boolean; reason?: string; severity?: IssueSeverity } {
  const showById = new Map(options.shows.map((s) => [s.id, s]));

  // Already the other person on this show. A show needs two people, so the same
  // name cannot fill both seats.
  if (options.assignments.some((a) => a.userId === userId && a.showId === show.id)) {
    return { ok: false, reason: "Already on this show", severity: "error" };
  }

  const clash = options.assignments.find((a) => {
    if (a.userId !== userId || a.showId === show.id) return false;
    const other = showById.get(a.showId);
    if (!other || other.status === "CANCELLED") return false;
    return instantsOverlap(show.startsAt, show.endsAt, other.startsAt, other.endsAt);
  });
  if (clash) {
    return {
      ok: false,
      reason: `Already on ${showLabel(showById.get(clash.showId)!)}`,
      severity: "error",
    };
  }

  const elsewhere = (options.elsewhere ?? []).find(
    (e) => e.userId === userId && instantsOverlap(show.startsAt, show.endsAt, e.startsAt, e.endsAt),
  );
  if (elsewhere) {
    return { ok: false, reason: `Already on ${elsewhere.label}`, severity: "error" };
  }

  if ((options.timeOffByUser?.[userId] ?? []).includes(show.dateISO)) {
    return { ok: true, reason: "Booked this day off", severity: "warning" };
  }

  const availability = options.availability;
  if (availability && availability.some((a) => a.userId === userId)) {
    const offered = availability.some(
      (a) => a.userId === userId && a.dateISO === show.dateISO && a.slot === show.slot,
    );
    if (!offered) return { ok: true, reason: "Did not offer this show", severity: "warning" };
  }

  return { ok: true };
}

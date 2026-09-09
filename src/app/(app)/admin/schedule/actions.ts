"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBossOrThrow } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import {
  formatDate,
  fromDbDate,
  isDateISO,
  isTimeHM,
  resolveSlotInstants,
  toDbDate,
} from "@/lib/domain/dates";
import { blockerFor, rankCandidates } from "@/lib/domain/assign";
import type { Candidate } from "@/lib/domain/assign";
import { planCopyForward } from "@/lib/domain/schedule";
import { PLATFORM_SHORT, SEATS, SEATS_PER_SHOW, SLOT_SHORT } from "@/lib/domain/types";
import type { Platform, Slot } from "@/lib/domain/types";
import { getReleaseView } from "@/lib/server/schedule";
import { getSettings } from "@/lib/server/settings";
import { scheduledHoursPrinted } from "@/lib/server/timeclock";

export interface ActionState {
  error?: string;
  ok?: string;
}

function refresh() {
  revalidatePath("/admin/schedule");
  revalidatePath("/dashboard");
  revalidatePath("/schedule");
  revalidatePath("/availability");
}

/** Loads a show with the bits every action needs to write a useful audit line. */
async function loadShow(showId: string) {
  return prisma.show.findUnique({
    where: { id: showId },
    select: {
      id: true,
      date: true,
      platform: true,
      slot: true,
      startsAt: true,
      endsAt: true,
      status: true,
      release: { select: { id: true, startDate: true, scheduleStatus: true } },
    },
  });
}

function labelFor(show: { date: Date; platform: Platform; slot: Slot }) {
  return `${PLATFORM_SHORT[show.platform]} ${SLOT_SHORT[show.slot]} on ${formatDate(fromDbDate(show.date))}`;
}

/* ------------------------------------------------------------- assignments */

const AssignSchema = z.object({
  showId: z.string().min(1),
  seat: z.coerce.number().int().min(1).max(SEATS_PER_SHOW),
  userId: z.string().min(1, "Pick who is working."),
});

/**
 * Puts a person in one of a show's two seats.
 *
 * Clashes elsewhere in the release are deliberately *not* rejected: the validator
 * reports them on the page so the boss sees the whole picture, rather than being
 * stopped mid-entry by a modal. Two things are refused outright, because neither
 * is a judgement call — a cancelled show, and putting the same person in both
 * seats.
 */
export async function assignToShow(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can edit the schedule." };
  }

  const parsed = AssignSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { showId, seat, userId } = parsed.data;

  const [show, user] = await Promise.all([
    loadShow(showId),
    prisma.user.findUnique({ where: { id: userId }, select: { name: true, isActive: true } }),
  ]);
  if (!show) return { error: "That show no longer exists." };
  if (!user) return { error: "That person no longer exists." };
  if (!user.isActive) return { error: `${user.name} is deactivated and cannot be scheduled.` };
  if (show.status === "CANCELLED") {
    return { error: "That show is cancelled. Bring it back first if it is running after all." };
  }

  // A show needs two different people. The database enforces this too; catching
  // it here turns a constraint violation into a sentence the boss can act on.
  const alreadyOn = await prisma.assignment.findFirst({
    where: { showId, userId, seat: { not: seat } },
    select: { id: true },
  });
  if (alreadyOn) {
    return { error: `${user.name} is already on this show. It needs two different people.` };
  }

  const previous = await prisma.assignment.findUnique({
    where: { showId_seat: { showId, seat } },
    select: { user: { select: { name: true } } },
  });

  // Upsert on (show, seat): the unique constraint means a seat can only ever
  // hold one person, so re-assigning replaces rather than stacking.
  await prisma.$transaction([
    prisma.assignment.upsert({
      where: { showId_seat: { showId, seat } },
      create: { showId, userId, seat, assignedById: boss.id },
      update: { userId, assignedById: boss.id },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Assignment",
        entityId: showId,
        action: previous ? "REPLACE" : "ASSIGN",
        actorId: boss.id,
        summary: previous
          ? `${labelFor(show)}: ${previous.user.name} → ${user.name}${show.release.scheduleStatus === "PUBLISHED" ? " (published schedule)" : ""}`
          : `${labelFor(show)}: added ${user.name}${show.release.scheduleStatus === "PUBLISHED" ? " (published schedule)" : ""}`,
      },
    }),
  ]);

  refresh();
  return {
    ok: previous ? `${user.name} replaces ${previous.user.name}.` : `${user.name} added.`,
  };
}

const SeatSchema = z.object({
  showId: z.string().min(1),
  seat: z.coerce.number().int().min(1).max(SEATS_PER_SHOW),
});

/** Takes one person off a show. */
export async function clearSeat(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can edit the schedule." };
  }

  const parsed = SeatSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { showId, seat } = parsed.data;

  const [show, existing] = await Promise.all([
    loadShow(showId),
    prisma.assignment.findUnique({
      where: { showId_seat: { showId, seat } },
      select: { id: true, user: { select: { name: true } } },
    }),
  ]);
  if (!show) return { error: "That show no longer exists." };
  if (!existing) return { ok: "That seat was already empty." };

  await prisma.$transaction([
    prisma.assignment.delete({ where: { id: existing.id } }),
    prisma.auditLog.create({
      data: {
        entityType: "Assignment",
        entityId: showId,
        action: "UNASSIGN",
        actorId: boss.id,
        summary: `${labelFor(show)}: removed ${existing.user.name}`,
      },
    }),
  ]);

  refresh();
  return { ok: `Removed ${existing.user.name}.` };
}

/* ------------------------------------------------------- editing the shows */

const HoursSchema = z.object({
  showId: z.string().min(1),
  start: z.string().refine(isTimeHM, "Use 24-hour times like 13:00."),
  end: z.string().refine(isTimeHM, "Use 24-hour times like 19:00."),
  notes: z.string().max(200).optional(),
});

/**
 * Changes one show's hours.
 *
 * An end at or before the start means the show runs past midnight — that is how
 * a 19:00–01:00 night show is expressed, so it is normal rather than an error.
 */
export async function updateShowHours(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can edit the schedule." };
  }

  const parsed = HoursSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  const show = await loadShow(d.showId);
  if (!show) return { error: "That show no longer exists." };

  const settings = await getSettings();
  const dateISO = fromDbDate(show.date);
  const { startsAt, endsAt, crossesMidnight } = resolveSlotInstants(
    dateISO,
    d.start,
    d.end,
    settings.timezone,
  );

  const hours = (endsAt.getTime() - startsAt.getTime()) / 3_600_000;
  if (hours > 16) return { error: "A show cannot run longer than 16 hours." };

  /*
    Hours are printed when a show starts and then stay put, so changing a show
    that has already run does not move anybody's pay — which is the safe
    behaviour, and also the surprising one if you assumed otherwise.

    Said out loud rather than left to be discovered at the end of the period,
    and it names the screen where the correction actually belongs.
  */
  const credited = await scheduledHoursPrinted(d.showId);

  await prisma.$transaction([
    prisma.show.update({
      where: { id: d.showId },
      data: { startsAt, endsAt, notes: d.notes?.trim() || null },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Show",
        entityId: d.showId,
        action: "UPDATE_HOURS",
        actorId: boss.id,
        summary: `${labelFor(show)}: hours set to ${d.start}–${d.end}${crossesMidnight ? " (next day)" : ""}${show.release.scheduleStatus === "PUBLISHED" ? " (published schedule)" : ""}`,
        before: { startsAt: show.startsAt.toISOString(), endsAt: show.endsAt.toISOString() },
        after: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      },
    }),
  ]);

  refresh();

  if (credited > 0) {
    return {
      ok:
        `${d.start}–${d.end}${crossesMidnight ? " (ends next day)" : ""}, ${hours} hours. ` +
        `Careful: ${credited} ${credited === 1 ? "person has" : "people have"} already been paid ` +
        `for this show at its old hours, and that has not changed. If their pay should change too, ` +
        `correct it on Timesheets.`,
    };
  }
  return { ok: `${d.start}–${d.end}${crossesMidnight ? " (ends next day)" : ""}, ${hours} hours.` };
}

const CancelSchema = z.object({
  showId: z.string().min(1),
  reason: z.string().max(200).optional(),
});

/**
 * Cancels a show, or brings a cancelled one back.
 *
 * Cancelling keeps the assignments rather than deleting them: if the show is
 * reinstated the same two people are still on it, and nobody has to be
 * re-picked from memory.
 */
export async function toggleShowCancelled(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can edit the schedule." };
  }

  const parsed = CancelSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const show = await loadShow(parsed.data.showId);
  if (!show) return { error: "That show no longer exists." };

  const cancelling = show.status === "SCHEDULED";
  const reason = parsed.data.reason?.trim();
  // Cancelling does not un-pay a show that already ran and was credited.
  const credited = cancelling ? await scheduledHoursPrinted(show.id) : 0;

  await prisma.$transaction([
    prisma.show.update({
      where: { id: show.id },
      data: {
        status: cancelling ? "CANCELLED" : "SCHEDULED",
        notes: cancelling ? reason || null : null,
      },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Show",
        entityId: show.id,
        action: cancelling ? "CANCEL" : "REINSTATE",
        actorId: boss.id,
        summary: `${labelFor(show)}: ${cancelling ? "cancelled" : "back on"}${reason ? ` — ${reason}` : ""}${show.release.scheduleStatus === "PUBLISHED" ? " (published schedule)" : ""}`,
      },
    }),
  ]);

  refresh();

  if (cancelling && credited > 0) {
    return {
      ok:
        `Cancelled. The people on it are free for other shows. ` +
        `Careful: ${credited} ${credited === 1 ? "person has" : "people have"} already been paid ` +
        `for it, and cancelling does not take that back. Remove the hours on Timesheets if it ` +
        `genuinely never ran.`,
    };
  }
  return {
    ok: cancelling
      ? "Cancelled. The people on it are free for other shows."
      : "Back on, with the same two people.",
  };
}

const AddShowSchema = z.object({
  releaseId: z.string().min(1),
  dateISO: z.string().refine(isDateISO, "Pick a valid date."),
  platform: z.enum(["TIKTOK", "EBAY"]),
  slot: z.enum(["DAY", "NIGHT"]),
  start: z.string().refine(isTimeHM, "Use 24-hour times like 13:00."),
  end: z.string().refine(isTimeHM, "Use 24-hour times like 19:00."),
});

/** Recreates a show that was deleted outright. */
export async function addShow(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can edit the schedule." };
  }

  const parsed = AddShowSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  const settings = await getSettings();
  const releaseId = d.releaseId;
  const { startsAt, endsAt } = resolveSlotInstants(d.dateISO, d.start, d.end, settings.timezone);

  const existing = await prisma.show.findUnique({
    where: {
      date_platform_slot: { date: toDbDate(d.dateISO), platform: d.platform, slot: d.slot },
    },
    select: { id: true, status: true, releaseId: true },
  });

  if (existing) {
    if (existing.releaseId !== releaseId) {
      return { error: "That show is already in another release." };
    }
    if (existing.status === "SCHEDULED") return { error: "That show already exists." };
    // A cancelled show already occupies the slot; reinstating is what was meant.
    await prisma.show.update({ where: { id: existing.id }, data: { status: "SCHEDULED" } });
    refresh();
    return { ok: "That show was cancelled — it is back on now." };
  }

  const created = await prisma.show.create({
    data: {
      releaseId,
      date: toDbDate(d.dateISO),
      platform: d.platform,
      slot: d.slot,
      startsAt,
      endsAt,
    },
    select: { id: true },
  });

  await prisma.auditLog.create({
    data: {
      entityType: "Show",
      entityId: created.id,
      action: "CREATE",
      actorId: boss.id,
      summary: `Added ${PLATFORM_SHORT[d.platform]} ${SLOT_SHORT[d.slot]} on ${formatDate(d.dateISO)}`,
    },
  });

  refresh();
  return { ok: `Added ${PLATFORM_SHORT[d.platform]} ${SLOT_SHORT[d.slot].toLowerCase()}.` };
}

const ReleaseSchema = z.object({ releaseId: z.string().min(1) });

const BulkHoursSchema = ReleaseSchema.extend({
  slot: z.enum(["DAY", "NIGHT"]),
  start: z.string().refine(isTimeHM, "Use 24-hour times like 13:00."),
  end: z.string().refine(isTimeHM, "Use 24-hour times like 19:00."),
});

/**
 * Sets the hours for every show in one slot across a whole release.
 *
 * The quick way to say "nights start an hour later this fortnight" without
 * opening thirty shows. One show can still be adjusted on its own afterwards.
 */
export async function setSlotHoursForRelease(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can edit the schedule." };
  }

  const parsed = BulkHoursSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  const release = await prisma.release.findUnique({
    where: { id: d.releaseId },
    select: { id: true, name: true, startDate: true, endDate: true },
  });
  if (!release) return { error: "That release no longer exists." };

  const settings = await getSettings();
  const shows = await prisma.show.findMany({
    where: { releaseId: release.id, slot: d.slot },
    select: { id: true, date: true },
  });
  if (shows.length === 0) return { error: `There are no ${SLOT_SHORT[d.slot].toLowerCase()} shows in this release.` };

  await prisma.$transaction([
    ...shows.map((show) => {
      const { startsAt, endsAt } = resolveSlotInstants(
        fromDbDate(show.date),
        d.start,
        d.end,
        settings.timezone,
      );
      return prisma.show.update({ where: { id: show.id }, data: { startsAt, endsAt } });
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Release",
        entityId: release.id,
        action: "SET_SLOT_HOURS",
        actorId: boss.id,
        summary: `Every ${SLOT_SHORT[d.slot].toLowerCase()} show set to ${d.start}–${d.end} (${shows.length} shows)`,
      },
    }),
  ]);

  refresh();
  return { ok: `${shows.length} ${SLOT_SHORT[d.slot].toLowerCase()} show(s) now run ${d.start}–${d.end}.` };
}

/** Publishes a release's schedule, so the team can see it. */
export async function publishRelease(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can publish." };
  }

  const parsed = ReleaseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { releaseId } = parsed.data;

  const view = await getReleaseView(releaseId);
  if (!view) return { error: "That release no longer exists." };
  if (!view.validation.canPublish) {
    return {
      error:
        view.validation.errors.length > 0
          ? `Cannot publish: ${view.validation.errors[0].message}`
          : "Cannot publish: this release has no shows yet.",
    };
  }

  const nextVersion = view.release.version + 1;

  // The snapshot is the record of what was actually sent out, so it can be
  // reconstructed even after the schedule is edited again.
  const payload = {
    releaseId,
    name: view.release.name,
    startDate: view.release.startDate,
    endDate: view.release.endDate,
    version: nextVersion,
    rules: {
      usePriority: view.release.usePriority,
      useProportional: view.release.useProportional,
      maxShowsPerPerson: view.release.maxShowsPerPerson,
      priorities: view.priorities.map((p) => ({ userId: p.userId, name: p.name, rank: p.rank })),
    },
    shows: view.shows.map((s) => ({
      id: s.id,
      date: s.dateISO,
      platform: s.platform,
      slot: s.slot,
      startHM: s.startHM,
      endHM: s.endHM,
      status: s.status,
      people: s.assignments.map((a) => ({ userId: a.userId, name: a.userName, seat: a.seat })),
    })),
  };

  await prisma.$transaction([
    prisma.release.update({
      where: { id: releaseId },
      data: {
        scheduleStatus: "PUBLISHED",
        version: nextVersion,
        publishedAt: new Date(),
        publishedById: boss.id,
        // Publishing settles the question, so answers close with it.
        status: "CLOSED",
        closedAt: new Date(),
      },
    }),
    prisma.scheduleSnapshot.create({
      data: { releaseId, version: nextVersion, payload, createdById: boss.id },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Release",
        entityId: releaseId,
        action: "PUBLISH",
        actorId: boss.id,
        summary: `Published ${view.release.label} as version ${nextVersion}`,
      },
    }),
  ]);

  refresh();
  return { ok: `Published as version ${nextVersion}. The team can see it now.` };
}

/**
 * Copies the previous release's people onto this one's shows.
 *
 * Matched on weekday, platform and slot rather than by date or position: a
 * release can be any length, so "the Tuesday night eBay show" is the only thing
 * that means the same in both. Anything with no counterpart is left empty, and
 * anybody the rules would refuse is skipped rather than forced in.
 */
export async function copyLastRelease(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can edit the schedule." };
  }

  const parsed = ReleaseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { releaseId } = parsed.data;

  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { id: true, startDate: true },
  });
  if (!release) return { error: "That release no longer exists." };

  const previous = await prisma.release.findFirst({
    where: { id: { not: releaseId }, endDate: { lt: release.startDate } },
    orderBy: { endDate: "desc" },
    select: { id: true, name: true, startDate: true, endDate: true },
  });
  if (!previous) return { error: "There is no earlier release to copy from." };

  const [previousShows, currentShows] = await Promise.all([
    prisma.show.findMany({
      where: { releaseId: previous.id, status: "SCHEDULED" },
      select: {
        date: true,
        platform: true,
        slot: true,
        assignments: { select: { userId: true, seat: true } },
      },
    }),
    prisma.show.findMany({
      where: { releaseId, status: "SCHEDULED" },
      select: { id: true, date: true, platform: true, slot: true, assignments: { select: { seat: true } } },
    }),
  ]);

  // Who can still be scheduled. See `planCopyForward` for why this is the whole
  // question rather than a copy.
  const eligible = new Set(
    (
      await prisma.user.findMany({
        where: { isActive: true, role: "EMPLOYEE", team: "STREAMING" },
        select: { id: true },
      })
    ).map((u) => u.id),
  );

  const { toCreate, skipped } = planCopyForward(
    previousShows,
    currentShows.map((s) => ({
      id: s.id,
      date: s.date,
      platform: s.platform,
      slot: s.slot,
      takenSeats: s.assignments.map((a) => a.seat),
    })),
    eligible,
  );

  if (toCreate.length === 0) {
    return {
      error:
        skipped > 0
          ? `Nothing to copy — the ${skipped} placement(s) that matched belong to people who are no longer streamers.`
          : "Nothing to copy — no matching shows, or every seat is already filled.",
    };
  }

  await prisma.$transaction([
    prisma.assignment.createMany({
      data: toCreate.map((c) => ({ ...c, assignedById: boss.id })),
      skipDuplicates: true,
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Release",
        entityId: releaseId,
        action: "COPY_PREVIOUS",
        actorId: boss.id,
        summary:
          `Copied ${toCreate.length} placements from the previous release` +
          (skipped > 0 ? `; skipped ${skipped} for people who are no longer streamers` : ""),
      },
    }),
  ]);

  refresh();
  return {
    ok:
      `Copied ${toCreate.length} placement(s) from the previous release. Check them before publishing.` +
      (skipped > 0
        ? ` ${skipped} were left out — those people are no longer streamers.`
        : ""),
  };
}

/** Empties every seat in the release, keeping the shows. */
export async function clearRelease(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can edit the schedule." };
  }

  const parsed = ReleaseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { releaseId } = parsed.data;

  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { id: true },
  });
  if (!release) return { error: "That release no longer exists." };

  const { count } = await prisma.assignment.deleteMany({ where: { show: { releaseId } } });
  if (count === 0) return { ok: "Nobody was scheduled anyway." };

  await prisma.auditLog.create({
    data: {
      entityType: "Release",
      entityId: releaseId,
      action: "CLEAR",
      actorId: boss.id,
      summary: `Cleared all ${count} assignments`,
    },
  });

  refresh();
  return { ok: `Cleared ${count} assignments. The shows themselves are still there.` };
}
/* --------------------------------------------------- generate and confirm */

/** One seat the generator wants to fill, with enough detail to show it. */
export interface ProposedPick {
  showId: string;
  seat: number;
  userId: string;
  userName: string;
  dateISO: string;
  showLabel: string;
  startHM: string;
  endHM: string;
}

/** A seat the generator could not fill, and why. */
export interface ProposedGap {
  showId: string;
  seat: number;
  dateISO: string;
  showLabel: string;
  reason: string;
}

export interface Proposal {
  releaseId: string;
  picks: ProposedPick[];
  gaps: ProposedGap[];
  /** Seats that were already taken before the generator ran. */
  keptSeats: number;
  totalSeats: number;
}

export interface GenerateState extends ActionState {
  proposal?: Proposal;
}

/**
 * Works out who would go where, without writing anything.
 *
 * The order it picks in, from `src/lib/domain/assign.ts`:
 *
 *   1. Fill as many seats as possible — but never by putting somebody on a show
 *      they did not offer. A seat with no willing candidate is left empty and
 *      shows in red, because a name nobody agreed to is worse than a gap.
 *   2. The people this release named as priority, if it turned that on.
 *   3. Whoever has used least of their own availability, if this release
 *      turned that on — work in proportion to what each person offered.
 *   4. Fewest shows so far, then name, so a rebuild is stable and the work
 *      spreads evenly.
 *
 * It never moves anyone already placed.
 */
async function buildProposal(releaseId: string): Promise<Proposal | null> {
  const view = await getReleaseView(releaseId);
  if (!view) return null;

  const rules = {
    usePriority: view.release.usePriority,
    useProportional: view.release.useProportional,
  };
  const priorityRank = new Map(view.priorities.map((p) => [p.userId, p.rank]));
  const counts = new Map<string, number>(
    view.streamers.map((s) => [s.id, view.validation.showsByUser[s.id] ?? 0]),
  );
  // How many shows each person offered across the whole release. This is what
  // rule 3 divides by, so the work lands in proportion to availability.
  const offeredByUser = new Map<string, number>();
  for (const a of view.availability) {
    offeredByUser.set(a.userId, (offeredByUser.get(a.userId) ?? 0) + 1);
  }

  // Running list of who is on what, so a person picked earlier in this pass is
  // not also picked for an overlapping show later in it.
  const placed = view.shows.flatMap((s) =>
    s.status === "SCHEDULED"
      ? s.assignments.map((a) => ({ userId: a.userId, startsAt: s.startsAt, endsAt: s.endsAt }))
      : [],
  );

  const picks: ProposedPick[] = [];
  const gaps: ProposedGap[] = [];
  let keptSeats = 0;
  let totalSeats = 0;

  for (const show of view.shows) {
    if (show.status === "CANCELLED") continue;
    const label = `${PLATFORM_SHORT[show.platform]} ${SLOT_SHORT[show.slot]} on ${formatDate(show.dateISO)}`;

    for (const seat of SEATS) {
      totalSeats++;
      const alreadyFilled =
        show.assignments.some((a) => a.seat === seat) ||
        picks.some((p) => p.showId === show.id && p.seat === seat);
      if (alreadyFilled) {
        keptSeats++;
        continue;
      }

      const onThisShow = new Set([
        ...show.assignments.map((a) => a.userId),
        ...picks.filter((p) => p.showId === show.id).map((p) => p.userId),
      ]);

      const seatContext = {
        dateISO: show.dateISO,
        startsAt: show.startsAt,
        endsAt: show.endsAt,
        onThisShow,
        placed,
      };

      let offered = 0;
      const candidates: Candidate[] = [];
      for (const person of view.streamers) {
        const offeredThisShow = view.availability.some(
          (a) => a.userId === person.id && a.dateISO === show.dateISO && a.slot === show.slot,
        );
        if (offeredThisShow) offered++;

        const blocker = blockerFor(
          {
            userId: person.id,
            offeredThisShow,
            daysOff: view.timeOffByUser[person.id] ?? [],
            assigned: counts.get(person.id) ?? 0,
            maxShows: view.release.maxShowsPerPerson,
          },
          seatContext,
        );
        if (blocker) continue;

        candidates.push({
          userId: person.id,
          name: person.name,
          priority: priorityRank.get(person.id) ?? 0,
          offered: offeredByUser.get(person.id) ?? 1,
          assigned: counts.get(person.id) ?? 0,
        });
      }

      if (candidates.length === 0) {
        gaps.push({
          showId: show.id,
          seat,
          dateISO: show.dateISO,
          showLabel: label,
          reason:
            offered === 0
              ? "Nobody offered this show"
              : "Everyone who offered it is already busy, off, or at their limit",
        });
        continue;
      }

      const chosen = rankCandidates(candidates, rules)[0];
      picks.push({
        showId: show.id,
        seat,
        userId: chosen.userId,
        userName: chosen.name,
        dateISO: show.dateISO,
        showLabel: label,
        startHM: show.startHM,
        endHM: show.endHM,
      });
      counts.set(chosen.userId, (counts.get(chosen.userId) ?? 0) + 1);
      placed.push({ userId: chosen.userId, startsAt: show.startsAt, endsAt: show.endsAt });
    }
  }

  return { releaseId, picks, gaps, keptSeats, totalSeats };
}

/**
 * Step one: build the schedule and hand it back for the boss to look at.
 *
 * Nothing is written. Everyone's availability goes in, a full proposal comes
 * out, and the boss confirms it — so a generate is never a surprise change to a
 * schedule people may already be reading.
 */
export async function generateSchedule(
  _prev: GenerateState,
  formData: FormData,
): Promise<GenerateState> {
  try {
    await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can edit the schedule." };
  }

  const parsed = ReleaseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const proposal = await buildProposal(parsed.data.releaseId);
  if (!proposal) return { error: "That release no longer exists." };

  if (proposal.totalSeats === 0) {
    return { error: "There are no shows in this release to fill." };
  }
  if (proposal.picks.length === 0) {
    return {
      error:
        proposal.gaps.length > 0
          ? "Nobody offered the empty shows, so there is nothing to fill them with."
          : "Every seat is already filled — nothing to generate.",
    };
  }

  return { proposal };
}

const CommitSchema = z.object({
  releaseId: z.string().min(1),
  picks: z
    .array(
      z.object({
        showId: z.string().min(1),
        seat: z.coerce.number().int().min(1).max(SEATS_PER_SHOW),
        userId: z.string().min(1),
      }),
    )
    .min(1, "There was nothing to confirm."),
});

/**
 * Step two: write the proposal that was on screen.
 *
 * Every pick is checked again against the schedule as it stands now, not as it
 * stood when the preview was drawn. In between, somebody may have been placed by
 * hand, taken a day off, or been moved to shipping — a stale pick is dropped and
 * reported rather than written over the top.
 */
export async function commitSchedule(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can edit the schedule." };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("picks") ?? "[]"));
  } catch {
    return { error: "That proposal could not be read. Generate it again." };
  }

  const parsed = CommitSchema.safeParse({
    releaseId: formData.get("releaseId"),
    picks: raw,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const view = await getReleaseView(parsed.data.releaseId);
  if (!view) return { error: "That release no longer exists." };

  const showById = new Map(view.shows.map((s) => [s.id, s]));
  const streamerIds = new Set(view.streamers.map((s) => s.id));
  const counts = new Map<string, number>(
    view.streamers.map((s) => [s.id, view.validation.showsByUser[s.id] ?? 0]),
  );
  const placed = view.shows.flatMap((s) =>
    s.status === "SCHEDULED"
      ? s.assignments.map((a) => ({ userId: a.userId, startsAt: s.startsAt, endsAt: s.endsAt }))
      : [],
  );

  const toWrite: { showId: string; seat: number; userId: string }[] = [];
  let dropped = 0;

  for (const pick of parsed.data.picks) {
    const show = showById.get(pick.showId);
    if (!show || show.status !== "SCHEDULED" || !streamerIds.has(pick.userId)) {
      dropped++;
      continue;
    }
    const taken =
      show.assignments.some((a) => a.seat === pick.seat) ||
      toWrite.some((w) => w.showId === pick.showId && w.seat === pick.seat);
    if (taken) {
      dropped++;
      continue;
    }

    const onThisShow = new Set([
      ...show.assignments.map((a) => a.userId),
      ...toWrite.filter((w) => w.showId === pick.showId).map((w) => w.userId),
    ]);

    const blocker = blockerFor(
      {
        userId: pick.userId,
        offeredThisShow: view.availability.some(
          (a) => a.userId === pick.userId && a.dateISO === show.dateISO && a.slot === show.slot,
        ),
        daysOff: view.timeOffByUser[pick.userId] ?? [],
        assigned: counts.get(pick.userId) ?? 0,
        maxShows: view.release.maxShowsPerPerson,
      },
      {
        dateISO: show.dateISO,
        startsAt: show.startsAt,
        endsAt: show.endsAt,
        onThisShow,
        placed,
      },
    );
    if (blocker) {
      dropped++;
      continue;
    }

    toWrite.push({ showId: pick.showId, seat: pick.seat, userId: pick.userId });
    counts.set(pick.userId, (counts.get(pick.userId) ?? 0) + 1);
    placed.push({ userId: pick.userId, startsAt: show.startsAt, endsAt: show.endsAt });
  }

  if (toWrite.length === 0) {
    return {
      error:
        "None of that proposal still holds — the schedule changed underneath it. Generate it again.",
    };
  }

  await prisma.$transaction([
    prisma.assignment.createMany({
      data: toWrite.map((w) => ({ ...w, assignedById: boss.id })),
      skipDuplicates: true,
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Release",
        entityId: view.release.id,
        action: "COMMIT_SCHEDULE",
        actorId: boss.id,
        summary: `Confirmed a generated schedule for ${view.release.label}: ${toWrite.length} seats filled${dropped > 0 ? `, ${dropped} dropped as out of date` : ""}`,
      },
    }),
  ]);

  refresh();
  return {
    ok:
      dropped > 0
        ? `Filled ${toWrite.length} seats. ${dropped} could not be applied — the schedule had changed.`
        : `Filled ${toWrite.length} seats.`,
  };
}

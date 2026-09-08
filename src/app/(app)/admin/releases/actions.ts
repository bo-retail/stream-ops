"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBossOrThrow } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import {
  datesBetween,
  formatDateRange,
  fromDbDate,
  isDateISO,
  isTimeHM,
  resolveSlotInstants,
  toDbDate,
} from "@/lib/domain/dates";
import { PLATFORM_SHORT, SLOT_SHORT } from "@/lib/domain/types";
import type { Platform, Slot } from "@/lib/domain/types";
import { getSettings } from "@/lib/server/settings";

export interface ReleaseState {
  error?: string;
  ok?: string;
  /** Set when a new release was created, so the page can go straight to it. */
  releaseId?: string;
}

function refresh(releaseId?: string) {
  revalidatePath("/admin/releases");
  revalidatePath("/admin/requests");
  revalidatePath("/admin/schedule");
  revalidatePath("/dashboard");
  revalidatePath("/availability");
  if (releaseId) revalidatePath(`/admin/releases/${releaseId}`);
}

/** The longest a single release may cover. A guard against a typo'd year. */
const MAX_DAYS = 92;

const CreateSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    startDate: z.string().refine(isDateISO, "Pick a start date."),
    endDate: z.string().refine(isDateISO, "Pick an end date."),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "The end date cannot be before the start date.",
    path: ["endDate"],
  });

/**
 * Starts a new release.
 *
 * It is created empty and in draft: no shows, no rules, nobody told. The boss
 * then composes it and sends it out as two separate acts, so half a thought is
 * never sitting in front of the team.
 */
export async function createRelease(
  _prev: ReleaseState,
  formData: FormData,
): Promise<ReleaseState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  const parsed = CreateSchema.safeParse({
    name: formData.get("name") ?? undefined,
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { name, startDate, endDate } = parsed.data;
  const days = datesBetween(startDate, endDate).length;
  if (days > MAX_DAYS) {
    return { error: `That is ${days} days. A release covers at most ${MAX_DAYS}.` };
  }

  const release = await prisma.release.create({
    data: {
      name: name?.trim() || null,
      startDate: toDbDate(startDate),
      endDate: toDbDate(endDate),
      createdById: boss.id,
    },
    select: { id: true },
  });

  await prisma.auditLog.create({
    data: {
      entityType: "Release",
      entityId: release.id,
      action: "CREATE",
      actorId: boss.id,
      summary: `Started a release for ${formatDateRange(startDate, endDate)}`,
    },
  });

  refresh(release.id);
  return { ok: "Release started. Now choose the shows.", releaseId: release.id };
}

const ShowPickSchema = z.object({
  dateISO: z.string().refine(isDateISO),
  platform: z.enum(["TIKTOK", "EBAY"]),
  slot: z.enum(["DAY", "NIGHT"]),
  startHM: z.string().refine(isTimeHM, "Enter a time as HH:MM."),
  endHM: z.string().refine(isTimeHM, "Enter a time as HH:MM."),
});

/**
 * Replaces the shows on a draft release with exactly what is on screen.
 *
 * Ticking and unticking a grid is how the boss thinks about this, so the whole
 * grid is sent and the difference worked out here. Shows that already have
 * somebody on them are never silently deleted — unticking one that is staffed
 * is refused and named, because it would take people off a shift without
 * saying so.
 */
export async function setReleaseShows(
  releaseId: string,
  picks: unknown,
): Promise<ReleaseState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  const parsed = z.array(ShowPickSchema).max(500).safeParse(picks);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { id: true, startDate: true, endDate: true, scheduleStatus: true },
  });
  if (!release) return { error: "That release no longer exists." };
  if (release.scheduleStatus === "PUBLISHED") {
    return { error: "That schedule is published. Change the shows on the schedule page instead." };
  }

  const settings = await getSettings();
  const within = new Set(
    datesBetween(
      release.startDate.toISOString().slice(0, 10),
      release.endDate.toISOString().slice(0, 10),
    ),
  );
  const outside = parsed.data.find((p) => !within.has(p.dateISO));
  if (outside) return { error: `${outside.dateISO} is outside this release's dates.` };

  const wanted = new Map(
    parsed.data.map((p) => [`${p.dateISO}|${p.platform}|${p.slot}`, p]),
  );

  const existing = await prisma.show.findMany({
    where: { releaseId },
    select: {
      id: true,
      date: true,
      platform: true,
      slot: true,
      _count: { select: { assignments: true } },
    },
  });

  const keyOf = (s: { date: Date; platform: Platform; slot: Slot }) =>
    `${s.date.toISOString().slice(0, 10)}|${s.platform}|${s.slot}`;

  const toRemove = existing.filter((s) => !wanted.has(keyOf(s)));
  const staffed = toRemove.filter((s) => s._count.assignments > 0);
  if (staffed.length > 0) {
    const first = staffed[0];
    return {
      error: `${PLATFORM_SHORT[first.platform]} ${SLOT_SHORT[first.slot]} on ${first.date
        .toISOString()
        .slice(0, 10)} has people on it. Take them off before removing it${
        staffed.length > 1 ? `, and ${staffed.length - 1} other(s)` : ""
      }.`,
    };
  }

  // A show belongs to one release and one only, so a date already claimed by a
  // neighbouring release has to be reported rather than crashing on the unique
  // index at write time.
  const clash = await prisma.show.findFirst({
    where: {
      releaseId: { not: releaseId },
      OR: parsed.data.map((p) => ({
        date: toDbDate(p.dateISO),
        platform: p.platform,
        slot: p.slot,
      })),
    },
    select: { date: true, platform: true, slot: true, release: { select: { name: true } } },
  });
  if (clash) {
    return {
      error: `${PLATFORM_SHORT[clash.platform]} ${SLOT_SHORT[clash.slot]} on ${clash.date
        .toISOString()
        .slice(0, 10)} is already in another release.`,
    };
  }

  const existingKeys = new Set(existing.map(keyOf));
  const toCreate = parsed.data.filter((p) => !existingKeys.has(`${p.dateISO}|${p.platform}|${p.slot}`));
  const toUpdate = existing.filter((s) => wanted.has(keyOf(s)));

  await prisma.$transaction([
    ...(toRemove.length > 0
      ? [prisma.show.deleteMany({ where: { id: { in: toRemove.map((s) => s.id) } } })]
      : []),
    ...(toCreate.length > 0
      ? [
          prisma.show.createMany({
            data: toCreate.map((p) => {
              const { startsAt, endsAt } = resolveSlotInstants(
                p.dateISO,
                p.startHM,
                p.endHM,
                settings.timezone,
              );
              return {
                releaseId,
                date: toDbDate(p.dateISO),
                platform: p.platform,
                slot: p.slot,
                startsAt,
                endsAt,
              };
            }),
            skipDuplicates: true,
          }),
        ]
      : []),
    // Hours can change on a show that already exists, so every kept show is
    // rewritten to whatever the grid now says.
    ...toUpdate.map((s) => {
      const p = wanted.get(keyOf(s))!;
      const { startsAt, endsAt } = resolveSlotInstants(
        p.dateISO,
        p.startHM,
        p.endHM,
        settings.timezone,
      );
      return prisma.show.update({ where: { id: s.id }, data: { startsAt, endsAt } });
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Release",
        entityId: releaseId,
        action: "SET_SHOWS",
        actorId: boss.id,
        summary: `Set the shows: ${parsed.data.length} across the release${
          toRemove.length > 0 ? `, ${toRemove.length} removed` : ""
        }`,
      },
    }),
  ]);

  refresh(releaseId);
  return {
    ok: `Saved — ${parsed.data.length} show${parsed.data.length === 1 ? "" : "s"} in this release.`,
  };
}

const RulesSchema = z.object({
  usePriority: z.boolean(),
  useProportional: z.boolean(),
  maxShowsPerPerson: z.number().int().min(1).max(200).nullable(),
  priorityUserIds: z.array(z.string().min(1)).max(50),
});

/**
 * The rules for this release, and only this release.
 *
 * Nothing here is remembered for next time. That is the point: who is worth
 * prioritising changes with what the fortnight needs, and a standing setting
 * quietly keeps applying long after the reason for it has gone.
 */
export async function setReleaseRules(releaseId: string, input: unknown): Promise<ReleaseState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  const parsed = RulesSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { usePriority, useProportional, maxShowsPerPerson, priorityUserIds } = parsed.data;

  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { id: true, scheduleStatus: true },
  });
  if (!release) return { error: "That release no longer exists." };

  if (usePriority && priorityUserIds.length === 0) {
    return { error: "Priority is on but nobody is named. Pick somebody, or switch it off." };
  }

  await prisma.$transaction([
    prisma.release.update({
      where: { id: releaseId },
      data: { usePriority, useProportional, maxShowsPerPerson },
    }),
    prisma.releasePriority.deleteMany({ where: { releaseId } }),
    ...(priorityUserIds.length > 0
      ? [
          prisma.releasePriority.createMany({
            // Listed best first, so the rank counts down from the top.
            data: priorityUserIds.map((userId, i) => ({
              releaseId,
              userId,
              rank: priorityUserIds.length - i,
            })),
            skipDuplicates: true,
          }),
        ]
      : []),
    prisma.auditLog.create({
      data: {
        entityType: "Release",
        entityId: releaseId,
        action: "SET_RULES",
        actorId: boss.id,
        summary: `Rules: priority ${usePriority ? `on (${priorityUserIds.length} named)` : "off"}, more-availability-more-work ${
          useProportional ? "on" : "off"
        }${maxShowsPerPerson ? `, cap ${maxShowsPerPerson}` : ""}`,
      },
    }),
  ]);

  refresh(releaseId);
  return { ok: "Rules saved for this release." };
}

const SendSchema = z.object({
  releaseId: z.string().min(1),
  dueAt: z.string().optional(),
});

/** Sends a draft release to the team. */
export async function sendRelease(
  _prev: ReleaseState,
  formData: FormData,
): Promise<ReleaseState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  const parsed = SendSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { releaseId } = parsed.data;

  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      _count: { select: { shows: true } },
    },
  });
  if (!release) return { error: "That release no longer exists." };
  if (release.status === "OPEN") return { error: "That release is already out." };
  if (release._count.shows === 0) {
    return { error: "There are no shows in it yet. Add some before sending it out." };
  }

  const raw = parsed.data.dueAt?.trim();
  let dueAt: Date | null = null;
  if (raw) {
    const parsedDate = new Date(raw);
    if (Number.isNaN(parsedDate.getTime())) return { error: "That deadline is not a valid date." };
    dueAt = parsedDate;
  }

  await prisma.$transaction([
    prisma.release.update({
      where: { id: releaseId },
      data: { status: "OPEN", releasedAt: new Date(), closedAt: null, dueAt },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Release",
        entityId: releaseId,
        action: "RELEASE",
        actorId: boss.id,
        summary: `Sent out for availability: ${release._count.shows} shows${
          dueAt ? `, due ${dueAt.toISOString().slice(0, 10)}` : ""
        }`,
      },
    }),
  ]);

  refresh(releaseId);
  return { ok: "Sent. The team can fill it in now." };
}

const RenameSchema = z.object({
  releaseId: z.string().min(1),
  name: z.string().trim().max(120),
});

/**
 * Renames a release, at any point in its life.
 *
 * Deliberately allowed after publishing, unlike everything else on a published
 * release. A name is a label for people to find it by, not part of the promise
 * made to the team: changing "Sept 16-30" to "Sept 16-30 — holiday cover" moves
 * nobody's shift and changes nobody's pay. The dates, the shows and the
 * placements stay locked once published; the label does not need to be.
 *
 * Clearing it is allowed too — the release falls back to being known by its
 * dates, which is how an unnamed one has always read.
 */
export async function renameRelease(releaseId: string, name: string): Promise<ReleaseState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  const parsed = RenameSchema.safeParse({ releaseId, name });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { name: true, startDate: true, endDate: true },
  });
  if (!release) return { error: "That release no longer exists." };

  const next = parsed.data.name.trim() || null;
  const before = release.name?.trim() || null;
  if (next === before) return {};

  const dates = `${fromDbDate(release.startDate)} to ${fromDbDate(release.endDate)}`;

  await prisma.$transaction([
    prisma.release.update({ where: { id: releaseId }, data: { name: next } }),
    prisma.auditLog.create({
      data: {
        entityType: "Release",
        entityId: releaseId,
        action: "RENAME",
        actorId: boss.id,
        summary: next
          ? `Renamed the release covering ${dates} to "${next}"`
          : `Cleared the name on the release covering ${dates}`,
        before: { name: before },
        after: { name: next },
      },
    }),
  ]);

  refresh(releaseId);
  return { ok: next ? `Renamed to "${next}".` : "Name cleared — it goes by its dates now." };
}

/** Stops taking answers. */
export async function closeRelease(releaseId: string): Promise<ReleaseState> {
  return setStatus(releaseId, "CLOSED", "Closed — no more answers will be taken.");
}

/** Takes answers again. */
export async function reopenRelease(releaseId: string): Promise<ReleaseState> {
  return setStatus(releaseId, "OPEN", "Open again. The team can change their answers.");
}

async function setStatus(
  releaseId: string,
  status: "OPEN" | "CLOSED",
  ok: string,
): Promise<ReleaseState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { status: true },
  });
  if (!release) return { error: "That release no longer exists." };
  if (release.status === "DRAFT") return { error: "That release has not been sent out yet." };

  await prisma.$transaction([
    prisma.release.update({
      where: { id: releaseId },
      data: { status, closedAt: status === "CLOSED" ? new Date() : null },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Release",
        entityId: releaseId,
        action: status === "CLOSED" ? "CLOSE" : "REOPEN",
        actorId: boss.id,
        summary: status === "CLOSED" ? "Closed for answers" : "Reopened for answers",
      },
    }),
  ]);

  refresh(releaseId);
  return { ok };
}

/**
 * Hands one person's answer back so they can change it.
 *
 * Their taps are kept — only the "I have finished" mark is removed — so they
 * correct an answer rather than starting from a blank fortnight.
 */
export async function reopenForPerson(
  releaseId: string,
  userId: string,
): Promise<ReleaseState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  const [release, user] = await Promise.all([
    prisma.release.findUnique({
      where: { id: releaseId },
      select: { scheduleStatus: true },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
  ]);
  if (!release || !user) return { error: "That is no longer there." };
  if (release.scheduleStatus === "PUBLISHED") {
    return { error: "That schedule is published — availability for it is history now." };
  }

  const deleted = await prisma.availabilitySubmission.deleteMany({
    where: { releaseId, userId },
  });
  if (deleted.count === 0) return { error: `${user.name} has not sent this one in.` };

  await prisma.auditLog.create({
    data: {
      entityType: "Release",
      entityId: releaseId,
      action: "REOPEN_PERSON",
      actorId: boss.id,
      summary: `Handed availability back to ${user.name} to change`,
    },
  });

  refresh(releaseId);
  return { ok: `${user.name} can edit their answer again. Their taps are still there.` };
}

/** What deleting a release would take with it, so it can be said out loud first. */
export interface DeleteImpact {
  label: string;
  shows: number;
  assignments: number;
  availability: number;
  submissions: number;
  published: boolean;
  /** Clocked time attached to these shows. Anything above zero blocks deletion. */
  timeEntries: number;
}

export async function getDeleteImpact(releaseId: string): Promise<DeleteImpact | null> {
  try {
    await requireBossOrThrow();
  } catch {
    return null;
  }

  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: {
      name: true,
      startDate: true,
      endDate: true,
      scheduleStatus: true,
      _count: { select: { shows: true, availability: true, submissions: true } },
    },
  });
  if (!release) return null;

  const [assignments, timeEntries] = await Promise.all([
    prisma.assignment.count({ where: { show: { releaseId } } }),
    prisma.timeEntry.count({ where: { show: { releaseId } } }),
  ]);

  const label =
    release.name?.trim() ||
    formatDateRange(fromDbDate(release.startDate), fromDbDate(release.endDate));

  return {
    label,
    shows: release._count.shows,
    assignments,
    availability: release._count.availability,
    submissions: release._count.submissions,
    published: release.scheduleStatus === "PUBLISHED",
    timeEntries,
  };
}

/**
 * Deletes a release and everything hanging off it.
 *
 * Any release can go, including a published one — the boss may simply have built
 * the wrong thing. The shows, the schedule on them, and the availability people
 * sent against it all go too, because none of them mean anything on their own.
 *
 * One hard refusal: if anybody has clocked time against these shows, the release
 * stays. Deleting it would detach those entries from their shifts, and a
 * streamer's paid hours are measured against the shift — so past pay would
 * silently change. That is not something to find out about later.
 */
export async function deleteRelease(releaseId: string): Promise<ReleaseState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  const impact = await getDeleteImpact(releaseId);
  if (!impact) return { error: "That release no longer exists." };

  if (impact.timeEntries > 0) {
    return {
      error: `Cannot delete: ${impact.timeEntries} clocked entr${
        impact.timeEntries === 1 ? "y is" : "ies are"
      } attached to these shows. Deleting it would change what people were paid for hours they have already worked.`,
    };
  }

  await prisma.$transaction([
    // Shows, assignments, availability and submissions all cascade from here.
    prisma.release.delete({ where: { id: releaseId } }),
    prisma.auditLog.create({
      data: {
        entityType: "Release",
        entityId: releaseId,
        action: "DELETE",
        actorId: boss.id,
        summary:
          `Deleted ${impact.published ? "the PUBLISHED release" : "the release"} ${impact.label} — ` +
          `${impact.shows} shows, ${impact.assignments} placements, ` +
          `${impact.availability} availability rows, ${impact.submissions} answers`,
      },
    }),
  ]);

  refresh();
  revalidatePath("/admin/requests");
  return {
    ok: `Deleted ${impact.label} and everything on it.`,
  };
}

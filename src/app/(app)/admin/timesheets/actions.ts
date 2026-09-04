"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBossOrThrow } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { isDateISO, isTimeHM, resolveSlotInstants } from "@/lib/domain/dates";
import { getSettings } from "@/lib/server/settings";

export interface TimesheetState {
  error?: string;
  ok?: string;
}

function refresh() {
  revalidatePath("/admin/timesheets");
  revalidatePath("/timeclock");
}

/**
 * Turns a business-zone date and `HH:mm` into a real instant.
 *
 * Reuses the schedule's resolver, which handles daylight saving properly — an
 * hour recorded on the night the clocks change must not silently move.
 */
async function instantFor(dateISO: string, time: string): Promise<Date> {
  const settings = await getSettings();
  return resolveSlotInstants(dateISO, time, time, settings.timezone).startsAt;
}

const EditSchema = z.object({
  entryId: z.string().min(1),
  dateISO: z.string().refine(isDateISO, "Pick a valid date."),
  startTime: z.string().refine(isTimeHM, "Use 24-hour times like 13:00."),
  endTime: z.string(),
  note: z.string().max(300).optional(),
  reason: z.string().trim().min(3, "Say why this is being changed.").max(300),
});

/**
 * Corrects a time entry.
 *
 * A reason is required. These hours are what somebody gets paid for, so "who
 * changed this, when, and why" has to be answerable months later — the revision
 * this writes is append-only and never edited again.
 */
export async function editEntry(
  _prev: TimesheetState,
  formData: FormData,
): Promise<TimesheetState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can change timesheets." };
  }

  const parsed = EditSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  const entry = await prisma.timeEntry.findUnique({
    where: { id: d.entryId },
    select: {
      id: true,
      version: true,
      clockInAt: true,
      clockOutAt: true,
      note: true,
      user: { select: { name: true } },
    },
  });
  if (!entry) return { error: "That entry no longer exists." };

  const clockInAt = await instantFor(d.dateISO, d.startTime);

  let clockOutAt: Date | null = null;
  if (d.endTime.trim() !== "") {
    if (!isTimeHM(d.endTime)) return { error: "Use 24-hour times like 21:30." };
    clockOutAt = await instantFor(d.dateISO, d.endTime);
    // An end before the start means the shift ran past midnight.
    if (clockOutAt.getTime() <= clockInAt.getTime()) {
      clockOutAt = new Date(clockOutAt.getTime() + 86_400_000);
    }
    const hours = (clockOutAt.getTime() - clockInAt.getTime()) / 3_600_000;
    if (hours > 16) return { error: "That is over 16 hours. Check the times." };
  }

  const nextVersion = entry.version + 1;
  const note = d.note?.trim() || null;

  await prisma.$transaction([
    prisma.timeEntry.update({
      where: { id: entry.id },
      data: { clockInAt, clockOutAt, note, version: nextVersion, source: "ADMIN" },
    }),
    prisma.timeEntryRevision.create({
      data: {
        timeEntryId: entry.id,
        version: nextVersion,
        clockInAt,
        clockOutAt,
        note,
        reason: d.reason.trim(),
        changedById: boss.id,
      },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "TimeEntry",
        entityId: entry.id,
        action: "EDIT",
        actorId: boss.id,
        summary: `${entry.user.name}: ${d.dateISO} ${d.startTime}–${d.endTime || "open"} — ${d.reason.trim()}`,
        before: {
          clockInAt: entry.clockInAt.toISOString(),
          clockOutAt: entry.clockOutAt?.toISOString() ?? null,
          note: entry.note,
        },
        after: {
          clockInAt: clockInAt.toISOString(),
          clockOutAt: clockOutAt?.toISOString() ?? null,
          note,
        },
      },
    }),
  ]);

  refresh();
  return { ok: `Updated ${entry.user.name}'s entry.` };
}

const AddSchema = z.object({
  userId: z.string().min(1, "Pick who this is for."),
  dateISO: z.string().refine(isDateISO, "Pick a valid date."),
  startTime: z.string().refine(isTimeHM, "Use 24-hour times like 13:00."),
  endTime: z.string().refine(isTimeHM, "Use 24-hour times like 19:00."),
  note: z.string().max(300).optional(),
  reason: z.string().trim().min(3, "Say why this is being added.").max(300),
});

/** Adds a shift somebody forgot to clock. */
export async function addEntry(
  _prev: TimesheetState,
  formData: FormData,
): Promise<TimesheetState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can add timesheet entries." };
  }

  const parsed = AddSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  const user = await prisma.user.findUnique({
    where: { id: d.userId },
    select: { name: true, isActive: true },
  });
  if (!user) return { error: "That person no longer exists." };

  const clockInAt = await instantFor(d.dateISO, d.startTime);
  let clockOutAt = await instantFor(d.dateISO, d.endTime);
  if (clockOutAt.getTime() <= clockInAt.getTime()) {
    clockOutAt = new Date(clockOutAt.getTime() + 86_400_000);
  }
  const hours = (clockOutAt.getTime() - clockInAt.getTime()) / 3_600_000;
  if (hours > 16) return { error: "That is over 16 hours. Check the times." };

  // An added entry is closed, so it never collides with the "one open entry per
  // person" index — somebody can be clocked in right now and still have a
  // forgotten shift filled in behind them.
  const created = await prisma.timeEntry.create({
    data: {
      userId: d.userId,
      clockInAt,
      clockOutAt,
      note: d.note?.trim() || null,
      source: "ADMIN",
      version: 1,
    },
    select: { id: true },
  });

  await prisma.$transaction([
    prisma.timeEntryRevision.create({
      data: {
        timeEntryId: created.id,
        version: 1,
        clockInAt,
        clockOutAt,
        note: d.note?.trim() || null,
        reason: `Added by admin — ${d.reason.trim()}`,
        changedById: boss.id,
      },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "TimeEntry",
        entityId: created.id,
        action: "CREATE",
        actorId: boss.id,
        summary: `Added ${user.name}: ${d.dateISO} ${d.startTime}–${d.endTime} — ${d.reason.trim()}`,
      },
    }),
  ]);

  refresh();
  return { ok: `Added ${hours.toFixed(2)}h for ${user.name}.` };
}

const DeleteSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().trim().min(3, "Say why this is being removed.").max(300),
});

/**
 * Removes an entry — a double clock-in, or time logged against the wrong person.
 *
 * The revisions go with it, so the audit log entry written here is what
 * survives: who it belonged to, the hours, who removed it and why.
 */
export async function deleteEntry(
  _prev: TimesheetState,
  formData: FormData,
): Promise<TimesheetState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can remove timesheet entries." };
  }

  const parsed = DeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const entry = await prisma.timeEntry.findUnique({
    where: { id: parsed.data.entryId },
    select: {
      id: true,
      clockInAt: true,
      clockOutAt: true,
      note: true,
      user: { select: { name: true } },
    },
  });
  if (!entry) return { error: "That entry no longer exists." };

  await prisma.$transaction([
    prisma.auditLog.create({
      data: {
        entityType: "TimeEntry",
        entityId: entry.id,
        action: "DELETE",
        actorId: boss.id,
        summary: `Removed ${entry.user.name}'s entry from ${entry.clockInAt.toISOString()} — ${parsed.data.reason.trim()}`,
        before: {
          user: entry.user.name,
          clockInAt: entry.clockInAt.toISOString(),
          clockOutAt: entry.clockOutAt?.toISOString() ?? null,
          note: entry.note,
        },
      },
    }),
    prisma.timeEntry.delete({ where: { id: entry.id } }),
  ]);

  refresh();
  return { ok: `Removed ${entry.user.name}'s entry.` };
}

/** Closes an entry somebody left open — the forgotten clock-out. */
export async function closeOpenEntry(
  _prev: TimesheetState,
  formData: FormData,
): Promise<TimesheetState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can do that." };
  }

  const entryId = String(formData.get("entryId") ?? "");
  const endTime = String(formData.get("endTime") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();

  if (!isTimeHM(endTime)) return { error: "Use a 24-hour time like 21:30." };
  if (reason.length < 3) return { error: "Say why this is being closed." };

  const entry = await prisma.timeEntry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      version: true,
      clockInAt: true,
      clockOutAt: true,
      note: true,
      user: { select: { name: true } },
    },
  });
  if (!entry) return { error: "That entry no longer exists." };
  if (entry.clockOutAt) return { error: "That entry is already closed." };

  const settings = await getSettings();
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(entry.clockInAt);

  let clockOutAt = await instantFor(day, endTime);
  if (clockOutAt.getTime() <= entry.clockInAt.getTime()) {
    clockOutAt = new Date(clockOutAt.getTime() + 86_400_000);
  }

  const nextVersion = entry.version + 1;

  await prisma.$transaction([
    prisma.timeEntry.update({
      where: { id: entry.id },
      data: { clockOutAt, version: nextVersion, source: "ADMIN" },
    }),
    prisma.timeEntryRevision.create({
      data: {
        timeEntryId: entry.id,
        version: nextVersion,
        clockInAt: entry.clockInAt,
        clockOutAt,
        note: entry.note,
        reason: `Closed by admin — ${reason}`,
        changedById: boss.id,
      },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "TimeEntry",
        entityId: entry.id,
        action: "CLOSE",
        actorId: boss.id,
        summary: `Closed ${entry.user.name}'s open entry at ${endTime} — ${reason}`,
      },
    }),
  ]);

  refresh();
  return { ok: `Closed ${entry.user.name}'s entry.` };
}

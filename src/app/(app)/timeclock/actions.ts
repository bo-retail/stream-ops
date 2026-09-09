"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUserOrThrow } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { paidWindow } from "@/lib/domain/hours";

export interface ClockState {
  error?: string;
  ok?: string;
}

function refresh() {
  revalidatePath("/timeclock");
  revalidatePath("/admin/timesheets");
  revalidatePath("/dashboard");
}

/** Longest a shift can run before it is almost certainly a forgotten clock-out. */
const MAX_SHIFT_HOURS = 16;

/**
 * Starts a shift.
 *
 * For a streamer the entry is linked to the show they are turning up for, and
 * the paid window is worked out from that later. Clocking in early does not
 * start the clock early; clocking in late does come off. Shipping has no
 * schedule, so nothing is attached and their raw hours count as clocked.
 *
 * The link is stored, not the adjusted time: the raw clock-in is what actually
 * happened and must stay recoverable.
 *
 * The database also holds a partial unique index allowing only one open entry
 * per person, so a double tap cannot open two.
 */
export async function clockIn(_prev: ClockState, formData: FormData): Promise<ClockState> {
  let user;
  try {
    user = await requireUserOrThrow();
  } catch {
    return { error: "You are not signed in." };
  }

  const note = String(formData.get("note") ?? "").trim();

  const open = await prisma.timeEntry.findFirst({
    where: { userId: user.id, clockOutAt: null },
    select: { clockInAt: true },
  });
  if (open) {
    return { error: "You are already clocked in. Clock out first." };
  }

  const now = new Date();

  try {
    const entry = await prisma.timeEntry.create({
      data: {
        userId: user.id,
        clockInAt: now,
        // No show is attached. A streamer's show hours come from the published
        // schedule and are printed when the show starts, so anything they clock
        // is off-schedule work by definition — and shipping never had a shift
        // to be measured against in the first place.
        showId: null,
        note: note || null,
        source: "SELF",
        version: 1,
      },
      select: { id: true },
    });

    // The first revision records the entry as originally made, so the history is
    // complete rather than starting from the first correction.
    await prisma.timeEntryRevision.create({
      data: {
        timeEntryId: entry.id,
        version: 1,
        clockInAt: now,
        clockOutAt: null,
        note: note || null,
        reason: "Clocked in",
        changedById: user.id,
      },
    });
  } catch (error) {
    // The partial unique index caught a second tap that raced the check above.
    if (isUniqueViolation(error)) return { error: "You are already clocked in." };
    throw error;
  }

  refresh();
  return { ok: "Clocked in." };
}

/** Ends the open shift. */
export async function clockOut(_prev: ClockState, formData: FormData): Promise<ClockState> {
  let user;
  try {
    user = await requireUserOrThrow();
  } catch {
    return { error: "You are not signed in." };
  }

  const note = String(formData.get("note") ?? "").trim();

  const open = await prisma.timeEntry.findFirst({
    where: { userId: user.id, clockOutAt: null },
    select: {
      id: true,
      clockInAt: true,
      note: true,
      version: true,
      show: { select: { startsAt: true, endsAt: true, status: true } },
    },
  });
  if (!open) return { error: "You are not clocked in." };

  const now = new Date();
  const hours = (now.getTime() - open.clockInAt.getTime()) / 3_600_000;
  if (hours > MAX_SHIFT_HOURS) {
    return {
      error: `That shift would be ${Math.round(hours)} hours. Ask your admin to correct the clock-in time instead.`,
    };
  }

  const nextVersion = open.version + 1;
  const combinedNote = [open.note, note].filter(Boolean).join(" · ") || null;

  await prisma.$transaction([
    prisma.timeEntry.update({
      where: { id: open.id },
      data: { clockOutAt: now, note: combinedNote, version: nextVersion },
    }),
    prisma.timeEntryRevision.create({
      data: {
        timeEntryId: open.id,
        version: nextVersion,
        clockInAt: open.clockInAt,
        clockOutAt: now,
        note: combinedNote,
        reason: "Clocked out",
        changedById: user.id,
      },
    }),
  ]);

  refresh();

  // Report what will be paid, not what the stopwatch said. Somebody who stayed
  // forty minutes late should not be told they earned forty extra minutes.
  const shift =
    open.show && open.show.status === "SCHEDULED"
      ? { startsAt: open.show.startsAt, endsAt: open.show.endsAt }
      : null;
  const paid = paidWindow({ clockInAt: open.clockInAt, clockOutAt: now }, shift);
  const minutes = paid.minutes ?? 0;
  const hm = `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

  if (paid.lateMinutes > 0) {
    return { ok: `Clocked out. ${hm} counted — ${paid.lateMinutes} min late.` };
  }
  if (paid.leftEarlyMinutes > 0) {
    return { ok: `Clocked out. ${hm} counted — ${paid.leftEarlyMinutes} min before the end.` };
  }
  if (paid.unpaidMinutes > 0) {
    return { ok: `Clocked out. ${hm} counted — the full shift.` };
  }
  return { ok: `Clocked out. ${hm} counted.` };
}

const NoteSchema = z.object({
  entryId: z.string().min(1),
  note: z.string().max(300),
});

/** Adds or changes the note on one of your own entries. */
export async function updateOwnNote(
  _prev: ClockState,
  formData: FormData,
): Promise<ClockState> {
  let user;
  try {
    user = await requireUserOrThrow();
  } catch {
    return { error: "You are not signed in." };
  }

  const parsed = NoteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const entry = await prisma.timeEntry.findUnique({
    where: { id: parsed.data.entryId },
    select: { id: true, userId: true, clockInAt: true, clockOutAt: true, version: true },
  });
  if (!entry) return { error: "That entry no longer exists." };
  // A note is the only thing a person may change on their own record, and only
  // on their own. The times themselves need an admin.
  if (entry.userId !== user.id) return { error: "That is not your entry." };

  const note = parsed.data.note.trim() || null;
  const nextVersion = entry.version + 1;

  await prisma.$transaction([
    prisma.timeEntry.update({
      where: { id: entry.id },
      data: { note, version: nextVersion },
    }),
    prisma.timeEntryRevision.create({
      data: {
        timeEntryId: entry.id,
        version: nextVersion,
        clockInAt: entry.clockInAt,
        clockOutAt: entry.clockOutAt,
        note,
        reason: "Note changed by the employee",
        changedById: user.id,
      },
    }),
  ]);

  refresh();
  return { ok: "Note saved." };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

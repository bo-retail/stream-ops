"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUserOrThrow } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { diffDays, formatDate, isDateISO, toDbDate } from "@/lib/domain/dates";

export interface TimeOffState {
  error?: string;
  ok?: string;
}

function refresh() {
  revalidatePath("/availability");
  revalidatePath("/admin/schedule");
  revalidatePath("/dashboard");
}

const RangeSchema = z
  .object({
    startDate: z.string().refine(isDateISO, "Pick a valid start date."),
    endDate: z.string().refine(isDateISO, "Pick a valid end date."),
    note: z.string().max(200).optional(),
  })
  .refine((v) => diffDays(v.startDate, v.endDate) >= 0, {
    message: "The end date cannot be before the start date.",
  });

/**
 * Books time off — a single day or a range.
 *
 * A declaration, not a request: it applies immediately, and the boss is warned
 * if they schedule the person anyway. Nobody waits on an approval to say they
 * are unavailable.
 */
export async function bookTimeOff(_prev: TimeOffState, formData: FormData): Promise<TimeOffState> {
  let user;
  try {
    user = await requireUserOrThrow();
  } catch {
    return { error: "You are not signed in." };
  }

  const parsed = RangeSchema.safeParse({
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
    note: formData.get("note") ?? undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  if (diffDays(d.startDate, d.endDate) > 180) {
    return { error: "That range is longer than six months. Book it in shorter blocks." };
  }

  // Offers on days now booked off are withdrawn.
  //
  // Filling and copying already skip days that are booked off, so the rule was
  // only enforced in one direction: offer first, book off second, and the two
  // sat contradicting each other. Nobody would have been scheduled — a booked
  // day is a hard block in the scheduler — but the availability page showed the
  // same day as both offered and off, and the boss saw an offer the person did
  // not mean. Booking a day off is the clearer statement, so it wins.
  const withdrawn = await prisma.availability.count({
    where: {
      userId: user.id,
      date: { gte: toDbDate(d.startDate), lte: toDbDate(d.endDate) },
    },
  });

  await prisma.$transaction([
    prisma.timeOff.create({
      data: {
        userId: user.id,
        startDate: toDbDate(d.startDate),
        endDate: toDbDate(d.endDate),
        note: d.note?.trim() || null,
      },
    }),
    prisma.availability.deleteMany({
      where: {
        userId: user.id,
        date: { gte: toDbDate(d.startDate), lte: toDbDate(d.endDate) },
      },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "TimeOff",
        entityId: user.id,
        action: "CREATE",
        actorId: user.id,
        summary:
          (d.startDate === d.endDate
            ? `${user.name} booked ${formatDate(d.startDate, "long")} off`
            : `${user.name} booked ${formatDate(d.startDate, "medium")} – ${formatDate(d.endDate, "medium")} off`) +
          (withdrawn > 0 ? ` — ${withdrawn} offer(s) withdrawn` : ""),
      },
    }),
  ]);

  refresh();
  return {
    ok:
      d.startDate === d.endDate
        ? `${formatDate(d.startDate, "medium")} marked as unavailable.`
        : `${formatDate(d.startDate, "short")} – ${formatDate(d.endDate, "short")} marked as unavailable.`,
  };
}

/** Toggles a single day off, for the per-day switch on the availability grid. */
export async function toggleDayOff(
  _prev: TimeOffState,
  formData: FormData,
): Promise<TimeOffState> {
  let user;
  try {
    user = await requireUserOrThrow();
  } catch {
    return { error: "You are not signed in." };
  }

  const dateISO = String(formData.get("dateISO") ?? "");
  if (!isDateISO(dateISO)) return { error: "Invalid date." };

  const existing = await prisma.timeOff.findFirst({
    where: {
      userId: user.id,
      startDate: { lte: toDbDate(dateISO) },
      endDate: { gte: toDbDate(dateISO) },
    },
    select: { id: true, startDate: true, endDate: true },
  });

  if (existing) {
    // Only a single-day booking can be cleared by this toggle — carving one day
    // out of a booked holiday from here would be surprising.
    if (existing.startDate.getTime() !== existing.endDate.getTime()) {
      return {
        error: "That day is part of a longer booking. Remove it from the Time off list below.",
      };
    }
    await prisma.timeOff.delete({ where: { id: existing.id } });
    refresh();
    return { ok: `${formatDate(dateISO, "medium")}: available again.` };
  }

  await prisma.$transaction([
    prisma.timeOff.create({
      data: { userId: user.id, startDate: toDbDate(dateISO), endDate: toDbDate(dateISO) },
    }),
    // Booking a day off withdraws any shows offered for it, so the two can never
    // contradict each other.
    prisma.availability.deleteMany({ where: { userId: user.id, date: toDbDate(dateISO) } }),
  ]);

  refresh();
  return { ok: `${formatDate(dateISO, "medium")}: marked as a day you cannot work.` };
}

export async function removeTimeOff(id: string): Promise<TimeOffState> {
  let user;
  try {
    user = await requireUserOrThrow();
  } catch {
    return { error: "You are not signed in." };
  }

  const record = await prisma.timeOff.findUnique({
    where: { id },
    select: { userId: true, user: { select: { name: true } } },
  });
  if (!record) return { error: "That booking no longer exists." };
  if (record.userId !== user.id && user.role !== "BOSS") {
    return { error: "You can only remove your own time off." };
  }

  await prisma.timeOff.delete({ where: { id } });
  refresh();
  return { ok: "Time off removed." };
}

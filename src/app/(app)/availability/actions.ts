"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUserOrThrow } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { formatDateRange, fromDbDate, isDateISO, toDbDate } from "@/lib/domain/dates";
import type { Slot } from "@/lib/domain/types";
import { businessOfRelease } from "@/lib/server/business";

export interface AvailabilityState {
  error?: string;
  ok?: string;
}

function refresh() {
  revalidatePath("/availability");
  revalidatePath("/dashboard");
  revalidatePath("/admin/schedule");
}

const SLOT = z.enum(["DAY", "NIGHT"]);

/**
 * Confirms the release is one this person is actually being asked about.
 *
 * Availability closes when the boss publishes, so a stale tab must not be able
 * to write to a period whose schedule is already out.
 */
async function assertOpen(releaseId: string): Promise<string | null> {
  const row = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { status: true, scheduleStatus: true },
  });
  if (!row) return "That request no longer exists.";
  if (row.scheduleStatus === "PUBLISHED") {
    return "That schedule is already out, so availability is closed.";
  }
  if (row.status !== "OPEN") return "That request is not taking answers.";
  return null;
}

/**
 * Confirms the release is open *and* this person has not already sent it in.
 *
 * A submission row exists only once somebody has pressed Submit, so its
 * presence is the lock. Everything they tap before that is a draft: saved, so a
 * closed tab or a flat battery costs nothing, but not yet an answer.
 */
async function assertEditable(userId: string, releaseId: string): Promise<string | null> {
  const closed = await assertOpen(releaseId);
  if (closed) return closed;

  const submitted = await prisma.availabilitySubmission.findUnique({
    where: { userId_releaseId: { userId, releaseId } },
    select: { id: true },
  });
  if (submitted) {
    return "You have already sent this one in. Ask your admin to reopen it if something has changed.";
  }
  return null;
}

const ToggleSchema = z.object({
  releaseId: z.string().min(1),
  dateISO: z.string().refine(isDateISO, "Invalid date."),
  slot: SLOT,
});

/**
 * Offers a show, or takes the offer back.
 *
 * One row per person, date and slot, so there is never any ambiguity about what
 * was said. Nobody picks a job: the two people on a show split it and swap
 * halfway, so "I can work this show" is the whole answer.
 */
export async function toggleShow(
  _prev: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  let user;
  try {
    user = await requireUserOrThrow();
  } catch {
    return { error: "You are not signed in." };
  }

  const parsed = ToggleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  const blocked = await assertEditable(user.id, d.releaseId);
  if (blocked) return { error: blocked };

  const slot = d.slot as Slot;

  // An answer belongs to the business whose release asked for it. Somebody on
  // both a watch and a diamond release for the same fortnight is answering two
  // separate questions about the same evening.
  const business = await businessOfRelease(d.releaseId);

  const existing = await prisma.availability.findUnique({
    where: {
      userId_business_date_slot: { userId: user.id, business, date: toDbDate(d.dateISO), slot },
    },
    select: { id: true },
  });

  if (existing) {
    await prisma.availability.delete({ where: { id: existing.id } });
    refresh();
    return { ok: "Taken back." };
  }

  await prisma.availability.create({
    data: {
      userId: user.id,
      releaseId: d.releaseId,
      business,
      date: toDbDate(d.dateISO),
      slot,
    },
  });

  refresh();
  return { ok: "Added." };
}

const ReleaseSchema = z.object({ releaseId: z.string().min(1) });

const FillSchema = ReleaseSchema.extend({
  slot: z.union([SLOT, z.literal("BOTH")]),
});

/** The dates and shows a release is actually asking about. */
async function releaseShows(releaseId: string) {
  return prisma.show.findMany({
    where: { releaseId, status: "SCHEDULED" },
    select: { date: true, slot: true },
    orderBy: [{ date: "asc" }],
  });
}

/**
 * Offers every show of one kind in the release — the common "I'm free all
 * fortnight".
 *
 * Only shows that actually exist in the release are offered. A release may run
 * days on some dates and nights on others, so filling from a calendar rather
 * than from the shows would invent offers for shows nobody is running.
 */
export async function fillPeriod(
  _prev: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  let user;
  try {
    user = await requireUserOrThrow();
  } catch {
    return { error: "You are not signed in." };
  }

  const parsed = FillSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  const blocked = await assertEditable(user.id, d.releaseId);
  if (blocked) return { error: blocked };

  const slots: Slot[] = d.slot === "BOTH" ? ["DAY", "NIGHT"] : [d.slot as Slot];
  const shows = await releaseShows(d.releaseId);

  // Days already booked off are skipped: offering a show on a day you cannot
  // work would put a contradiction in front of the boss.
  const timeOff = await prisma.timeOff.findMany({
    where: { userId: user.id },
    select: { startDate: true, endDate: true },
  });

  const seen = new Set<string>();
  const rows: { dateISO: string; slot: Slot }[] = [];
  for (const show of shows) {
    if (!slots.includes(show.slot)) continue;
    const dateISO = fromDbDate(show.date);
    const isOff = timeOff.some(
      (t) => fromDbDate(t.startDate) <= dateISO && fromDbDate(t.endDate) >= dateISO,
    );
    if (isOff) continue;
    // Both platforms share a slot, so one tap answers for both.
    const key = `${dateISO}|${show.slot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ dateISO, slot: show.slot });
  }

  if (rows.length === 0) {
    return {
      error:
        shows.length === 0
          ? "There are no shows in this request."
          : "Every day with those shows is booked off, so there is nothing to offer.",
    };
  }

  const business = await businessOfRelease(d.releaseId);

  await prisma.$transaction(
    rows.map((r) =>
      prisma.availability.upsert({
        where: {
          userId_business_date_slot: {
            userId: user.id,
            business,
            date: toDbDate(r.dateISO),
            slot: r.slot,
          },
        },
        create: {
          userId: user.id,
          releaseId: d.releaseId,
          business,
          date: toDbDate(r.dateISO),
          slot: r.slot,
        },
        update: {},
      }),
    ),
  );

  refresh();
  return { ok: `Offered ${rows.length} shows.` };
}

/** Clears everything offered for the period. */
export async function clearPeriodAvailability(
  _prev: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  let user;
  try {
    user = await requireUserOrThrow();
  } catch {
    return { error: "You are not signed in." };
  }

  const parsed = ReleaseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const blocked = await assertEditable(user.id, parsed.data.releaseId);
  if (blocked) return { error: blocked };

  const { count } = await prisma.availability.deleteMany({
    where: { userId: user.id, releaseId: parsed.data.releaseId },
  });

  refresh();
  return { ok: count === 0 ? "Nothing was offered anyway." : `Cleared ${count} shows.` };
}

/**
 * Copies what was offered on the release before this one.
 *
 * Matched on weekday rather than by date or position: releases are whatever
 * length the boss made them, so "the Tuesday night show" is the only thing that
 * means the same in both. Anything with no counterpart in this release is
 * dropped rather than guessed at.
 */
export async function copyLastPeriodAvailability(
  _prev: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  let user;
  try {
    user = await requireUserOrThrow();
  } catch {
    return { error: "You are not signed in." };
  }

  const parsed = ReleaseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { releaseId } = parsed.data;

  const blocked = await assertEditable(user.id, releaseId);
  if (blocked) return { error: blocked };

  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { startDate: true },
  });
  if (!release) return { error: "That request no longer exists." };

  const previous = await prisma.release.findFirst({
    where: { id: { not: releaseId }, endDate: { lt: release.startDate } },
    orderBy: { endDate: "desc" },
    select: { id: true, name: true, startDate: true, endDate: true },
  });
  if (!previous) return { error: "There is no earlier request to copy from." };

  const source = await prisma.availability.findMany({
    where: { userId: user.id, releaseId: previous.id },
    select: { date: true, slot: true },
  });
  if (source.length === 0) {
    return { error: "You did not offer anything last time." };
  }

  const offeredWeekdays = new Set(source.map((r) => `${r.date.getUTCDay()}|${r.slot}`));

  const shows = await releaseShows(releaseId);
  const timeOff = await prisma.timeOff.findMany({
    where: { userId: user.id },
    select: { startDate: true, endDate: true },
  });

  const seen = new Set<string>();
  const rows: { dateISO: string; slot: Slot }[] = [];
  for (const show of shows) {
    if (!offeredWeekdays.has(`${show.date.getUTCDay()}|${show.slot}`)) continue;
    const dateISO = fromDbDate(show.date);
    const isOff = timeOff.some(
      (t) => fromDbDate(t.startDate) <= dateISO && fromDbDate(t.endDate) >= dateISO,
    );
    if (isOff) continue;
    const key = `${dateISO}|${show.slot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ dateISO, slot: show.slot });
  }

  if (rows.length === 0) {
    return { error: "Nothing you offered last time lines up with this request." };
  }

  const business = await businessOfRelease(releaseId);

  await prisma.$transaction(
    rows.map((r) =>
      prisma.availability.upsert({
        where: {
          userId_business_date_slot: {
            userId: user.id,
            business,
            date: toDbDate(r.dateISO),
            slot: r.slot,
          },
        },
        create: {
          userId: user.id,
          releaseId,
          business,
          date: toDbDate(r.dateISO),
          slot: r.slot,
        },
        update: {},
      }),
    ),
  );

  refresh();
  return { ok: `Copied ${rows.length} shows from your last answer.` };
}

/**
 * Sends the period in.
 *
 * Everything tapped up to this point is a draft that only this person can see —
 * the scheduler ignores it. This is the moment it becomes an answer, so it is
 * also the moment it stops being editable: the boss can build a schedule on it
 * and needs it to hold still. If something changes afterwards, the boss reopens
 * it from Settings.
 */
export async function submitAvailability(
  _prev: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  let user;
  try {
    user = await requireUserOrThrow();
  } catch {
    return { error: "You are not signed in." };
  }

  const parsed = ReleaseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const blocked = await assertEditable(user.id, parsed.data.releaseId);
  if (blocked) return { error: blocked };

  const release = await prisma.release.findUnique({
    where: { id: parsed.data.releaseId },
    select: { name: true, startDate: true, endDate: true },
  });
  if (!release) return { error: "That request no longer exists." };
  const label =
    release.name?.trim() ||
    formatDateRange(fromDbDate(release.startDate), fromDbDate(release.endDate));

  const offered = await prisma.availability.count({
    where: { userId: user.id, releaseId: parsed.data.releaseId },
  });

  try {
    await prisma.availabilitySubmission.create({
      data: { userId: user.id, releaseId: parsed.data.releaseId },
    });
  } catch (error) {
    // Two taps racing each other. The unique index settles it; the second tap
    // is told what the first one achieved rather than shown a failure.
    if (isUniqueViolation(error)) return { ok: "Already sent in." };
    throw error;
  }

  await prisma.auditLog.create({
    data: {
      entityType: "AvailabilitySubmission",
      entityId: `${user.id}:${parsed.data.releaseId}`,
      action: "SUBMIT_AVAILABILITY",
      actorId: user.id,
      summary:
        offered === 0
          ? `${user.name} sent in ${label} offering no shows`
          : `${user.name} sent in ${label} — ${offered} show${offered === 1 ? "" : "s"} offered`,
    },
  });

  refresh();
  revalidatePath("/admin/requests");
  return {
    ok:
      offered === 0
        ? "Sent in — you have offered no shows this time."
        : `Sent in — ${offered} show${offered === 1 ? "" : "s"} offered.`,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { formatDate, isDateISO, toDbDate } from "@/lib/domain/dates";

export interface DismissState {
  error?: string;
  ok?: string;
}

function refresh() {
  revalidatePath("/dashboard");
  revalidatePath("/sales-reports");
}

/**
 * Takes a missing-report day off the dashboard.
 *
 * It settles a to-do and nothing else: no sales, boxes or figures are touched,
 * and Sales report entry still lists the day as missing with the name of
 * whoever cleared it. What it stops is a banner that cannot be cleared — and a
 * banner people learn to scroll past takes the one that matters with it.
 *
 * Cleared for the whole team, because chasing a report is a shared job and one
 * person settling it should settle it for everybody. Recorded with a name so
 * the decision is answerable rather than anonymous.
 */
export async function dismissMissingReport(dateISO: string): Promise<DismissState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: "Only the shipping director or an admin can clear these." };
  }
  if (!isDateISO(dateISO)) return { error: "That is not a date." };

  await prisma.$transaction([
    prisma.dismissedReport.upsert({
      where: { showDate: toDbDate(dateISO) },
      create: { showDate: toDbDate(dateISO), dismissedById: user.id },
      update: { dismissedById: user.id, dismissedAt: new Date() },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Report",
        entityId: dateISO,
        action: "DISMISS_MISSING",
        actorId: user.id,
        summary: `Cleared ${formatDate(dateISO)} off the dashboard. Its report is still missing.`,
      },
    }),
  ]);

  refresh();
  return { ok: `${formatDate(dateISO)} cleared.` };
}

/** Puts a cleared day back on the dashboard. */
export async function restoreMissingReport(dateISO: string): Promise<DismissState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: "Only the shipping director or an admin can do that." };
  }
  if (!isDateISO(dateISO)) return { error: "That is not a date." };

  await prisma.$transaction([
    prisma.dismissedReport.deleteMany({ where: { showDate: toDbDate(dateISO) } }),
    prisma.auditLog.create({
      data: {
        entityType: "Report",
        entityId: dateISO,
        action: "RESTORE_MISSING",
        actorId: user.id,
        summary: `Put ${formatDate(dateISO)} back on the dashboard.`,
      },
    }),
  ]);

  refresh();
  return { ok: `${formatDate(dateISO)} is back on the dashboard.` };
}

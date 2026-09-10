"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow, requireShippingOrThrow } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { isDateISO, toDbDate } from "@/lib/domain/dates";
import {
  createUnknownBox,
  markDaySent,
  openBoxByScan,
  overrideItem,
  packItem,
  sealBox,
  unsealBox,
} from "@/lib/server/packing";
import type { ScanOutcome } from "@/lib/server/packing";

/**
 * Who may do what at the scanner.
 *
 * Deliberately thin. Everything these do lives in `lib/server/packing`, which
 * takes a user id and touches no request context, so the whole flow can be
 * exercised against a real database without pretending to be a browser. What is
 * left here is the part that genuinely is the web's problem: an action is a
 * public endpoint whichever page rendered it, so each one checks for itself.
 */

export type { ScanOutcome };

function refresh() {
  revalidatePath("/shipping");
  revalidatePath("/shipping/log");
  revalidatePath("/sales-reports");
}

const NOT_SHIPPING = "Only the shipping team can pack boxes.";

export async function scanLabel(rawScan: string): Promise<ScanOutcome> {
  try {
    const user = await requireShippingOrThrow();
    return await openBoxByScan(user.id, rawScan);
  } catch {
    return { kind: "error", message: NOT_SHIPPING };
  }
}

export async function startUnknownBox(rawScan: string): Promise<ScanOutcome> {
  let user;
  try {
    user = await requireShippingOrThrow();
  } catch {
    return { kind: "error", message: NOT_SHIPPING };
  }
  const outcome = await createUnknownBox(user.id, rawScan);
  refresh();
  return outcome;
}

export async function scanItem(packageId: string, rawScan: string): Promise<ScanOutcome> {
  try {
    const user = await requireShippingOrThrow();
    return await packItem(user.id, packageId, rawScan);
  } catch {
    return { kind: "error", message: NOT_SHIPPING };
  }
}

export async function addAnyway(packageId: string, stockNumber: string): Promise<ScanOutcome> {
  try {
    const user = await requireShippingOrThrow();
    return await overrideItem(user.id, packageId, stockNumber);
  } catch {
    return { kind: "error", message: NOT_SHIPPING };
  }
}

export async function closeBox(
  packageId: string,
  force: boolean,
  note?: string,
): Promise<ScanOutcome> {
  let user;
  try {
    user = await requireShippingOrThrow();
  } catch {
    return { kind: "error", message: NOT_SHIPPING };
  }
  const outcome = await sealBox(user.id, packageId, force, note);
  if (outcome.kind === "box") refresh();
  return outcome;
}

export interface MarkSentState {
  error?: string;
  ok?: string;
}

/**
 * Marks a whole day sent without scanning it.
 *
 * The director's, not a packer's: it closes hundreds of boxes at once and
 * declares that nobody verified any of them. A reason is required and goes on
 * every box as well as the audit log — "the scanner was down" and "these
 * shipped before we had the app" are different facts, and in six months only
 * the written one will be recoverable.
 */
export async function markDayAsSent(
  _prev: MarkSentState,
  formData: FormData,
): Promise<MarkSentState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: "Only the shipping director or an admin can do that." };
  }

  const dateISO = String(formData.get("date") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (!isDateISO(dateISO)) return { error: "That is not a valid day." };

  const result = await markDaySent(user.id, toDbDate(dateISO), reason);
  if ("error" in result) return { error: result.error };

  await prisma.auditLog.create({
    data: {
      entityType: "Package",
      entityId: dateISO,
      action: "MARK_DAY_SENT",
      actorId: user.id,
      summary:
        `Marked ${result.closed} box(es) on ${dateISO} as sent without scanning. ` +
        `Reason: ${reason.trim()}`,
    },
  });

  refresh();
  return {
    ok: `${result.closed} box(es) marked sent. They are recorded as never scanned here.`,
  };
}

/** Reopening is a correction, so it needs the director rather than a packer. */
export async function reopenBox(packageId: string, reason: string): Promise<ScanOutcome> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { kind: "error", message: "Only the shipping director or an admin can reopen a box." };
  }
  const outcome = await unsealBox(user.id, packageId, reason);
  if (outcome.kind === "box") refresh();
  return outcome;
}

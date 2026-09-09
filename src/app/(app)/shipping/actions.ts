"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow, requireShippingOrThrow } from "@/lib/auth/guards";
import {
  createUnknownBox,
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

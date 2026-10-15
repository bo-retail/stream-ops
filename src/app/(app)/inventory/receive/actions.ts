"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { addDays, formatDate, isDateISO, todayISO } from "@/lib/domain/dates";
import { getStartDate } from "@/lib/server/deduction";
import { readReceivingSheet, saveReceipt, undoReceipt } from "@/lib/server/receive";
import { getSettings } from "@/lib/server/settings";

export interface ReceiveState {
  error?: string;
  ok?: string;
  details?: string[];
}

const MAX_BYTES = 15 * 1024 * 1024;
const NOT_ALLOWED = "Only an admin or a shipping director can change stock.";

/** A received delivery, added to stock. Nothing is added unless every row is readable. */
export async function uploadReceipt(_prev: ReceiveState, formData: FormData): Promise<ReceiveState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: NOT_ALLOWED };
  }
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the filled-in receiving sheet first." };
  if (file.size > MAX_BYTES) return { error: "That file is too big to be the receiving sheet." };
  const on = String(formData.get("on") ?? "");
  const today = todayISO((await getSettings()).timezone);
  if (!isDateISO(on) || on > addDays(today, 1)) return { error: "Pick the day it was received." };
  // A delivery from before the starting count was in the count already.
  const start = await getStartDate();
  if (start && on < start) {
    return {
      error: `It arrived before the starting count (${formatDate(start)}), so it was counted already. Nothing was added.`,
    };
  }

  const confirmedEarly = formData.get("confirm") === "on";
  if (start && on === start && !confirmedEarly) {
    return {
      error:
        `This is the starting count's own day (${formatDate(start)}). If these watches were already on the shelf when ` +
        `they were counted, do not add them. If they arrived after the count, tick "Yes, add it anyway" and upload again.`,
    };
  }

  const { entries, problems, notes } = await readReceivingSheet(await file.arrayBuffer());
  if (problems.length > 0) return { error: "Nothing was added. Fix these and upload it again:", details: problems.slice(0, 50) };
  if (entries.length === 0) return { error: "No quantities were found. Is the sheet filled in?" };

  const confirmed = formData.get("confirm") === "on";
  const result = await saveReceipt(user.id, entries, on, file.name, confirmed);
  if (!result.ok) return { error: "Nothing was added.", details: result.problems.slice(0, 50) };

  revalidatePath("/inventory");
  revalidatePath("/inventory/receive");
  return {
    ok: `Added to inventory: ${result.pieces} piece(s) of ${result.models} model(s), received ${on}.`,
    details: [
      `Placed: Sellable ${result.placed.SELLABLE}, TT sample ${result.placed.SAMPLE_TIKTOK}, eBay sample ${result.placed.SAMPLE_EBAY}, Random pulls ${result.placed.RANDOM_PULLS}.`,
      ...(result.added.length > 0 ? [`${result.added.length} new model(s) added: ${result.added.join(", ")}.`] : []),
      ...notes,
    ],
  };
}

/** Takes a delivery added with wrong numbers back off stock. */
export async function undoDelivery(_prev: ReceiveState, formData: FormData): Promise<ReceiveState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: NOT_ALLOWED };
  }
  const entryId = String(formData.get("entryId") ?? "");
  if (!entryId) return { error: "Which delivery?" };
  const result = await undoReceipt(user.id, entryId);
  revalidatePath("/inventory");
  revalidatePath("/inventory/receive");
  return result.ok ? { ok: result.message } : { error: result.message };
}

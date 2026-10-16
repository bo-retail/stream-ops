"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { addDays, formatDate, isDateISO, todayISO } from "@/lib/domain/dates";
import { getStartDate } from "@/lib/server/deduction";
import { readReceivingSheet } from "@/lib/server/receive";
import { saveReturn, undoReturn } from "@/lib/server/returns";
import { getSettings } from "@/lib/server/settings";

export interface ReturnsState {
  error?: string;
  ok?: string;
  details?: string[];
  /** Models never in inventory: the page asks where each goes, then sends the same upload again with the answers. */
  needsPlace?: { model: string; qty: number }[];
}

const MAX_BYTES = 15 * 1024 * 1024;
const NOT_ALLOWED = "Only an admin or a shipping director can change stock.";

/** Returned watches, back to stock. Nothing is added unless every row is readable. */
export async function uploadReturns(_prev: ReturnsState, formData: FormData): Promise<ReturnsState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: NOT_ALLOWED };
  }
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the filled-in returns sheet first." };
  if (file.size > MAX_BYTES) return { error: "That file is too big to be the returns sheet." };
  const on = String(formData.get("on") ?? "");
  const today = todayISO((await getSettings()).timezone);
  if (!isDateISO(on) || on > addDays(today, 1)) return { error: "Pick the day they came back." };
  const confirmed = formData.get("confirm") === "on";
  // Back before the starting count: they were on the shelf when it was counted.
  const start = await getStartDate();
  if (start && on < start) {
    return { error: `They came back before the starting count (${formatDate(start)}), so they were counted already. Nothing was added.` };
  }
  if (start && on === start && !confirmed) {
    return {
      error:
        `This is the starting count's own day (${formatDate(start)}). If these watches were already on the shelf when ` +
        `they were counted, do not add them. If they came back after the count, tick "Yes, add it anyway" and upload again.`,
    };
  }

  const { entries, problems, notes } = await readReceivingSheet(await file.arrayBuffer(), "returns sheet");
  if (problems.length > 0) return { error: "Nothing was added. Fix these and upload it again:", details: problems.slice(0, 50) };
  if (entries.length === 0) return { error: "No quantities were found. Is the sheet filled in?" };

  // "place:<model>": where a model never in inventory goes, answered in the page's popup.
  const placeFor: Record<string, string> = {};
  for (const [key, value] of formData.entries()) if (key.startsWith("place:")) placeFor[key.slice(6)] = String(value);
  const result = await saveReturn(user.id, entries, on, file.name, confirmed, String(formData.get("name") ?? ""), placeFor);
  if (result.needsPlace.length > 0) return { needsPlace: result.needsPlace };
  if (!result.ok) return { error: "Nothing was added.", details: result.problems.slice(0, 50) };

  revalidatePath("/inventory");
  revalidatePath("/inventory/returns");
  return {
    ok: `Back in inventory: ${result.pieces} piece(s) of ${result.models} model(s), returned ${on}.`,
    details: [
      `Placed: Sellable ${result.placed.SELLABLE}, TT sample ${result.placed.SAMPLE_TIKTOK}, eBay sample ${result.placed.SAMPLE_EBAY}, Random pulls ${result.placed.RANDOM_PULLS}.`,
      ...(result.added.length > 0
        ? [`Never in inventory before, so added as new model(s): ${result.added.join(", ")}. Check each number against the watch; a typo can be undone below.`]
        : []),
      ...notes,
    ],
  };
}

/** Takes returns added with wrong numbers back off stock. */
export async function undoReturns(_prev: ReturnsState, formData: FormData): Promise<ReturnsState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: NOT_ALLOWED };
  }
  const entryId = String(formData.get("entryId") ?? "");
  if (!entryId) return { error: "Which returns?" };
  const result = await undoReturn(user.id, entryId);
  revalidatePath("/inventory");
  revalidatePath("/inventory/returns");
  return result.ok ? { ok: result.message } : { error: result.message };
}

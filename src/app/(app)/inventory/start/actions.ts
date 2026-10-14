"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { addDays, isDateISO, todayISO } from "@/lib/domain/dates";
import { getSettings } from "@/lib/server/settings";
import { bringStockUpToDate } from "@/lib/server/deduction";
import { readStartingCount, saveStartingCount } from "@/lib/server/starting-count";

export interface StartState {
  error?: string;
  ok?: string;
  details?: string[];
}

const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Inventory starts again from the uploaded sheet, and sales come off from the
 * show day given. Nothing is saved unless every row is readable.
 */
export async function uploadStartingCount(_prev: StartState, formData: FormData): Promise<StartState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: "Only an admin or a shipping director can change stock." };
  }
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the filled-in sheet first." };
  if (file.size > MAX_BYTES) return { error: "That file is too big to be the count sheet." };
  const start = String(formData.get("start") ?? "");
  if (!isDateISO(start)) return { error: "Pick the show day sales should start coming off from." };
  /*
    Not before yesterday. Every sale from the start day on comes off the new
    count, so a day picked too early — or mistyped — would take off watches
    that shipped long before the count. Yesterday stays possible for a count
    finished after midnight.
  */
  const today = todayISO((await getSettings()).timezone);
  if (start < addDays(today, -1)) {
    return { error: `Sales can start coming off from yesterday at the earliest. Pick ${today} (today) unless the count was finished after midnight.` };
  }

  const { entries, problems, notes } = await readStartingCount(await file.arrayBuffer());
  if (problems.length > 0) {
    return { error: "Nothing was saved. Fix these and upload it again:", details: problems.slice(0, 50) };
  }
  if (entries.length === 0) return { error: "No numbers were found. Is the sheet filled in?" };

  const result = await saveStartingCount(user.id, entries, start, file.name);
  if (!result.ok) return { error: "Nothing was saved. Fix these and upload it again:", details: result.problems.slice(0, 50) };

  // The sales from the start day on, taken off the new numbers straight away.
  let subtracted = "";
  try {
    const run = await bringStockUpToDate(user.id);
    subtracted = `${run.sold} sale(s) from ${start} on were taken off.`;
  } catch {
    subtracted = "The sales from that day on could not be taken off just now; they come off the next time inventory is opened.";
  }

  revalidatePath("/inventory");
  return {
    ok: `Inventory starts again: ${result.models} model(s), ${result.pieces} piece(s) counted. ${subtracted}`,
    details: [
      ...(result.zeroed > 0 ? [`${result.zeroed} model(s) that had stock before and are not on the sheet are now zero.`] : []),
      ...(result.added.length > 0
        ? [`Added ${result.added.length} model(s) that were not in the catalogue: ${result.added.join(", ")}.`]
        : []),
      ...notes,
    ],
  };
}

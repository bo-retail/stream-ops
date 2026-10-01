"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { isDateISO } from "@/lib/domain/dates";
import { bringStockUpToDate, setStartDate } from "@/lib/server/deduction";

export interface SalesState {
  error?: string;
  ok?: string;
}

const NOT_ALLOWED = "Only an admin or a shipping director can do that.";

async function director() {
  try {
    return await requireShippingDirectorOrThrow();
  } catch {
    return null;
  }
}

/**
 * The first show day whose sales come off stock — the first show after the
 * opening count. Blank turns it off again.
 */
export async function saveStartDate(date: string): Promise<SalesState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  const d = String(date ?? "").trim();
  if (d !== "" && !isDateISO(d)) return { error: "Pick a date." };
  await setStartDate(user.id, d === "" ? null : d);
  let r;
  try {
    r = await bringStockUpToDate(user.id);
  } catch {
    revalidatePath("/inventory", "layout");
    return { error: "The date is saved, but stock could not be brought up to date just now. Open this page again in a minute." };
  }
  revalidatePath("/inventory", "layout");
  if (d === "") return { ok: "Turned off: new sales no longer come off stock. What already came off stays as it is." };
  return { ok: `Sales come off stock from the shows of ${d}: ${r.sold} taken off, ${r.sent} already sent.` };
}

export async function updateNow(): Promise<SalesState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  try {
    const r = await bringStockUpToDate(user.id);
    revalidatePath("/inventory", "layout");
    if (!r.on) return { ok: "Nothing to do: no start date is set." };
    const did = r.sold + r.sent + r.putBack + r.unsent;
    return { ok: did === 0 ? "Already up to date." : `Up to date: ${r.sold} taken off, ${r.sent} sent, ${r.putBack} put back, ${r.unsent} back to waiting.` };
  } catch {
    return { error: "Stock could not be brought up to date just now. Try again in a minute." };
  }
}

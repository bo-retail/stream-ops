"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { isDateISO } from "@/lib/domain/dates";
import { FILE_KEYS, type FileKey, type PlanChoice } from "@/lib/domain/show-plan";
import { releaseFile, savePlan } from "@/lib/server/show-plan";

export interface PlanState {
  error?: string;
  problems?: string[];
  ok?: string;
  version?: number;
}

/** Saves the day's plan. The server checks it again against the shelf as it is now. */
export async function savePlanAction(date: string, version: number | null, choices: PlanChoice[]): Promise<PlanState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: "Only an admin or a shipping director can do that." };
  }
  if (!isDateISO(date)) return { error: "Pick a date." };
  if (!Array.isArray(choices)) return { error: "Nothing to save." };
  const clean: PlanChoice[] = choices.map((c) => ({
    model: String(c?.model ?? ""),
    AM: Number(c?.AM ?? 0),
    PM: Number(c?.PM ?? 0),
    setPrice: c?.setPrice === true,
  }));
  const r = await savePlan(user.id, date, version, clean);
  if (!r.ok) return { error: "Not saved.", problems: r.problems };
  revalidatePath("/inventory/plan");
  return { ok: `Saved. ${r.summary}`, version: r.version };
}

/** Frees a downloaded file that was not uploaded, so its numbers can change. */
export async function releaseFileAction(date: string, key: string): Promise<PlanState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: "Only an admin or a shipping director can do that." };
  }
  if (!isDateISO(date) || !(FILE_KEYS as readonly string[]).includes(key)) return { error: "No such file." };
  const r = await releaseFile(user.id, date, key as FileKey);
  revalidatePath("/inventory/plan");
  return r.ok ? { ok: r.message } : { error: r.message };
}

"use server";

import { revalidatePath } from "next/cache";
import { requireBossOrThrow } from "@/lib/auth/guards";
import { readGoal } from "@/lib/domain/morning";
import { saveMorningGoal } from "@/lib/server/morning";

/** Changes the morning numbers' goal. Admins and shipping directors. */
export async function saveGoal(revenue: string, margin: string): Promise<{ error?: string; ok?: string }> {
  let user;
  try {
    // The goal includes a margin, and margin is for admins only.
    user = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can change the goal." };
  }
  const r = readGoal(revenue, margin);
  if (!r.ok) return { error: r.why };
  await saveMorningGoal(user.id, r.goal);
  revalidatePath("/inventory/morning");
  return { ok: "Goal saved." };
}

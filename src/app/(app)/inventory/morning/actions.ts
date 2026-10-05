"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { readGoal } from "@/lib/domain/morning";
import { saveMorningGoal } from "@/lib/server/morning";

/** Changes the morning numbers' goal. Admins and shipping directors. */
export async function saveGoal(revenue: string, margin: string): Promise<{ error?: string; ok?: string }> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: "Only an admin or a shipping director can do that." };
  }
  const r = readGoal(revenue, margin);
  if (!r.ok) return { error: r.why };
  await saveMorningGoal(user.id, r.goal);
  revalidatePath("/inventory/morning");
  return { ok: "Goal saved." };
}

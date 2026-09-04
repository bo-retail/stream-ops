"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBossOrThrow } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { isSupportedTimezone } from "@/lib/domain/timezones";

export interface SettingsState {
  error?: string;
  ok?: string;
}

const Schema = z.object({
  timezone: z.string().min(1).max(64),
});

/**
 * The one thing that really is the same every time.
 *
 * Show hours, the show list and the scheduling rules used to live here as
 * standing defaults. They moved onto each release: this business has no default
 * fortnight, and a default that is wrong most weeks is worse than no default at
 * all. What is left is the time zone, which genuinely does not change.
 */
export async function saveSettings(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  let boss;
  try {
    boss = await requireBossOrThrow();
  } catch {
    return { error: "Only an admin can change settings." };
  }

  const parsed = Schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { timezone } = parsed.data;
  if (!isSupportedTimezone(timezone)) return { error: "That time zone is not supported." };

  const before = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (before?.timezone === timezone) return { ok: "Nothing to change." };

  await prisma.$transaction([
    prisma.settings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", timezone },
      update: { timezone },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Settings",
        entityId: "singleton",
        action: "UPDATE",
        actorId: boss.id,
        summary: `Time zone set to ${timezone}`,
        before: before ? { timezone: before.timezone } : undefined,
        after: { timezone },
      },
    }),
  ]);

  revalidatePath("/admin/settings");
  revalidatePath("/admin/schedule");
  revalidatePath("/timeclock");
  return {
    ok: "Saved. Existing shows keep the times they were created with — the clock reads them in the new zone.",
  };
}

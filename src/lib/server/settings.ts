import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { addDays, fromDbDate, todayISO, weekStart } from "@/lib/domain/dates";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";
import type { BusinessSettings } from "@/lib/domain/types";

/**
 * Business configuration, cached per request.
 *
 * Every screen needs the time zone, so this is memoised for the lifetime of a request rather than re-queried per component.
 */
export const getSettings = cache(async (): Promise<BusinessSettings> => {
  const row =
    (await prisma.settings.findUnique({ where: { id: "singleton" } })) ??
    (await prisma.settings.create({ data: { id: "singleton" } }));

  return {
    timezone: row.timezone,
  };
});

/** Today, and the current and upcoming schedule weeks, in the business zone. */
export async function getWeekContext() {
  const settings = await getSettings();
  const today = todayISO(settings.timezone);
  const currentWeek = weekStart(today);
  return { settings, today, currentWeek, nextWeek: addDays(currentWeek, 7) };
}

export { DEFAULT_SETTINGS, fromDbDate };

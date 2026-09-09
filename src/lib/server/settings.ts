import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { fromDbDate, todayISO } from "@/lib/domain/dates";
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
    streamerHourlyCents: row.streamerHourlyCents,
    shippingHourlyCents: row.shippingHourlyCents,
    streamerCommissionBps: row.streamerCommissionBps,
  };
});

/**
 * Today, in the business time zone.
 *
 * This used to hand back a current and a next *week* as well, left over from
 * when the app was organised weekly. Nothing is weekly any more: a release is
 * whatever dates the boss picked, and pay periods are halves of a month. Those
 * two fields caused a real bug — a caller passed both into a period lookup, both
 * snapped to the same half-month, and every show came back twice — so they are
 * gone rather than left lying around to be picked up again.
 */
export async function getWeekContext() {
  const settings = await getSettings();
  return { settings, today: todayISO(settings.timezone) };
}

export { DEFAULT_SETTINGS, fromDbDate };

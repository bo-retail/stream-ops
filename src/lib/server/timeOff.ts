import "server-only";
import { prisma } from "@/lib/db";
import { fromDbDate, toDbDate } from "@/lib/domain/dates";
import type { DateISO } from "@/lib/domain/types";

export interface TimeOffRange {
  id: string;
  userId: string;
  startDate: DateISO;
  endDate: DateISO;
  note: string | null;
  recordedByName: string | null;
}

/** Every time-off range overlapping the given window. */
export async function getTimeOffInRange(range: {
  from: DateISO;
  to: DateISO;
  userId?: string;
}): Promise<TimeOffRange[]> {
  const rows = await prisma.timeOff.findMany({
    where: {
      ...(range.userId ? { userId: range.userId } : {}),
      // Overlap, not containment: a holiday starting before the week and ending
      // inside it still takes those days out.
      startDate: { lte: toDbDate(range.to) },
      endDate: { gte: toDbDate(range.from) },
    },
    orderBy: [{ startDate: "asc" }],
    select: {
      id: true,
      userId: true,
      startDate: true,
      endDate: true,
      note: true,
      recordedBy: { select: { name: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    startDate: fromDbDate(r.startDate),
    endDate: fromDbDate(r.endDate),
    note: r.note,
    recordedByName: r.recordedBy?.name ?? null,
  }));
}

/** Time off as `{ userId: [dates] }`, the shape the scheduler and validator want. */
export async function getTimeOffByUser(range: {
  from: DateISO;
  to: DateISO;
}): Promise<Record<string, DateISO[]>> {
  const ranges = await getTimeOffInRange(range);
  const expanded = expandTimeOff(ranges);

  // Trim to the window asked for, so a month-long holiday does not swamp a
  // single week's view.
  return Object.fromEntries(
    Object.entries(expanded).map(([userId, dates]) => [
      userId,
      dates.filter((d) => d >= range.from && d <= range.to),
    ]),
  );
}

/** Expands stored time-off ranges into the individual dates they cover. */
function expandTimeOff(
  ranges: { userId: string; startDate: DateISO; endDate: DateISO }[],
): Record<string, DateISO[]> {
  const byUser: Record<string, Set<DateISO>> = {};
  for (const range of ranges) {
    const set = (byUser[range.userId] ??= new Set());
    const end = new Date(`${range.endDate}T00:00:00.000Z`).getTime();
    for (
      let d = new Date(`${range.startDate}T00:00:00.000Z`);
      d.getTime() <= end;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      set.add(d.toISOString().slice(0, 10));
      // Guard against an inverted or corrupt range looping forever.
      if (set.size > 400) break;
    }
  }
  return Object.fromEntries(Object.entries(byUser).map(([k, v]) => [k, [...v].sort()]));
}

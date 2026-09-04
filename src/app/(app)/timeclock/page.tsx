import type { Metadata } from "next";
import { PageHeader, Stat } from "@/components/ui";
import { requireUser } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { formatMinutes } from "@/lib/domain/dates";
import { formatPeriod, periodFor } from "@/lib/domain/periods";
import { PLATFORM_SHORT, SLOT_SHORT } from "@/lib/domain/types";
import { getEntriesInRange, getOpenEntry } from "@/lib/server/timeclock";
import { getWeekContext } from "@/lib/server/settings";
import { ClockPanel, MyEntries } from "./clock-client";
import type { ClockEntry } from "./clock-client";

export const metadata: Metadata = { title: "Time clock" };

export default async function TimeClockPage() {
  const user = await requireUser();
  const { today, settings } = await getWeekContext();

  // Always the period we are actually in. There is no way to move off it,
  // deliberately: clocking in always happens now, so a page showing some other
  // period would imply you could clock into it. Past hours live on the boss's
  // timesheets, which is also where a correction has to be made anyway.
  const period = periodFor(today);

  const [open, entries] = await Promise.all([
    getOpenEntry(user.id),
    getEntriesInRange({ from: period.start, to: period.end, userId: user.id }),
  ]);

  // What is coming up, so somebody clocking in knows what they are clocking in
  // for. Only relevant when they are not already on the clock.
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  let nextShift: { label: string; hours: string; dateISO: string } | null = null;
  if (!open) {
    const now = new Date();
    const upcoming = await prisma.assignment.findFirst({
      where: {
        userId: user.id,
        show: { status: "SCHEDULED", endsAt: { gte: now } },
      },
      orderBy: { show: { startsAt: "asc" } },
      select: {
        show: { select: { date: true, platform: true, slot: true, startsAt: true, endsAt: true } },
      },
    });
    if (upcoming) {
      nextShift = {
        label: `${PLATFORM_SHORT[upcoming.show.platform]} ${SLOT_SHORT[upcoming.show.slot]}`,
        hours: `${clock.format(upcoming.show.startsAt)}–${clock.format(upcoming.show.endsAt)}`,
        dateISO: upcoming.show.date.toISOString().slice(0, 10),
      };
    }
  }

  // Newest first for reading; the range query returns oldest first.
  const rows: ClockEntry[] = [...entries].reverse().map((e) => ({
    id: e.id,
    dateISO: e.dateISO,
    startHM: e.startHM,
    endHM: e.endHM,
    paidMinutes: e.paidMinutes,
    shiftLabel: e.shift ? `${e.shift.label} ${e.shift.startHM}–${e.shift.endHM}` : null,
    lateMinutes: e.lateMinutes,
    leftEarlyMinutes: e.leftEarlyMinutes,
    note: e.note,
  }));

  const totalMinutes = entries.reduce((m, e) => m + (e.paidMinutes ?? 0), 0);

  return (
    <>
      <PageHeader title="Time clock" description={formatPeriod(period)} />

      <div className="grid gap-5 lg:grid-cols-[24rem_1fr]">
        <div className="space-y-4">
          {/* Keyed on the clock state so the panel resets when it flips: a stale
              "Clocked in." message must not survive a clock-out. */}
          <ClockPanel
            key={open ? open.id : "clocked-out"}
            openSince={open ? open.clockInAt.toISOString() : null}
            shiftLabel={open?.shift?.label ?? null}
            shiftHours={open?.shift ? `${open.shift.startHM}–${open.shift.endHM}` : null}
            nextShift={nextShift}
          />

          <Stat
            label="Hours this period"
            value={formatMinutes(totalMinutes)}
            sub={`${entries.length} shift${entries.length === 1 ? "" : "s"}`}
          />
        </div>

        <div className="space-y-3">
          <MyEntries entries={rows} />
        </div>
      </div>
    </>
  );
}

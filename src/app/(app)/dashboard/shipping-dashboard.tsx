import { Card, CardHeader, EmptyState, LinkButton, PageHeader, Stat } from "@/components/ui";
import { MissingReports } from "@/components/missing-reports";
import type { AuthUser } from "@/lib/auth/guards";
import { formatDate, formatMinutes } from "@/lib/domain/dates";
import { formatPeriod, periodFor } from "@/lib/domain/periods";
import { getEntriesInRange, getOpenEntry } from "@/lib/server/timeclock";
import { getWeekContext } from "@/lib/server/settings";
import { missingReportsSafe } from "@/lib/server/shipping";

/**
 * The dashboard for somebody on shipping.
 *
 * Deliberately not the streamer one with the scheduling parts hidden. They have
 * no schedule and are never asked for availability, so the only thing that
 * matters to them is the clock — and being shown an empty "your next shows"
 * would suggest they had missed something.
 */
export async function ShippingDashboard({ user }: { user: AuthUser }) {
  const { today } = await getWeekContext();
  const period = periodFor(today);

  // Only the director is chased about missing reports — a packer cannot act on
  // one, and a warning nobody can clear is noise on somebody's morning.
  const isDirector = user.role === "MANAGER" || user.role === "BOSS";

  const [open, entries, missingReports] = await Promise.all([
    getOpenEntry(user.id),
    getEntriesInRange({ from: period.start, to: period.end, userId: user.id }),
    isDirector ? missingReportsSafe() : Promise.resolve([]),
  ]);

  const minutes = entries.reduce((m, e) => m + (e.paidMinutes ?? 0), 0);
  const openEntries = entries.filter((e) => e.paidMinutes === null).length;
  const recent = [...entries].reverse().slice(0, 8);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <>
      <PageHeader
        title={`${greeting}, ${user.name.split(" ")[0]}`}
        description={`Today is ${formatDate(today, "long")}.`}
        action={
          <LinkButton href="/timeclock" variant="primary">
            {open ? "Clock out" : "Clock in"}
          </LinkButton>
        }
      />

      {missingReports.length > 0 ? (
        <div className="mb-5">
          <MissingReports days={missingReports} />
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="On the clock"
          value={open ? "Yes" : "No"}
          tone={open ? "ok" : undefined}
          sub={open ? "Running now" : "Not clocked in"}
        />
        <Stat label="Hours this pay period" value={formatMinutes(minutes)} sub={formatPeriod(period)} />
        <Stat
          label="Shifts"
          value={entries.length - openEntries}
          tone={openEntries > 0 ? "warn" : undefined}
          sub={openEntries > 0 ? `${openEntries} not clocked out` : "All closed off"}
        />
      </div>

      <Card className="mt-5">
        <CardHeader
          title="Your recent shifts"
          description={`${formatPeriod(period)} — what you have clocked.`}
          action={
            <LinkButton href="/timeclock" size="sm">
              Open the clock
            </LinkButton>
          }
        />
        {recent.length === 0 ? (
          <EmptyState title="Nothing clocked this pay period">
            Your hours appear here once you clock in.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {recent.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{formatDate(entry.dateISO)}</p>
                  <p className="tabular text-xs text-ink-subtle">
                    {entry.startHM}–{entry.endHM ?? "still on"}
                  </p>
                </div>
                <span className="tabular shrink-0 text-sm font-semibold text-ink">
                  {entry.paidMinutes === null ? "—" : formatMinutes(entry.paidMinutes)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

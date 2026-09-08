import { Alert, Card, CardHeader, EmptyState, LinkButton, PageHeader, Stat } from "@/components/ui";
import { PlatformBadge, SlotBadge } from "@/components/show-labels";
import type { AuthUser } from "@/lib/auth/guards";
import { formatDate, formatMinutes } from "@/lib/domain/dates";
import { getOpenReleasesForUser } from "@/lib/server/availability";
import { getEmployeePeriod, getUpcomingShows } from "@/lib/server/schedule";
import { getWeekContext } from "@/lib/server/settings";

export async function EmployeeDashboard({ user }: { user: AuthUser }) {
  const { today } = await getWeekContext();

  // The pay period for the counts, and a plain forward look for the list.
  // Cancelled shows never reach the list: the point of a cancellation is that
  // the person does not turn up, so it must not sit in what is coming next.
  const [thisPeriod, upcoming, openReleases] = await Promise.all([
    getEmployeePeriod(user.id, today),
    getUpcomingShows(user.id, 8),
    getOpenReleasesForUser(user.id),
  ]);

  const runningThisPeriod = thisPeriod.shows.filter((s) => s.status === "SCHEDULED");
  const thisPeriodMinutes = runningThisPeriod.reduce(
    (m, s) => m + Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000),
    0,
  );
  const outstanding = openReleases.filter((r) => !r.submitted);

  return (
    <>
      <PageHeader
        title={`Hi, ${user.name.split(" ")[0]}`}
        description={`Today is ${formatDate(today, "long")}.`}
        action={
          <LinkButton href="/availability" variant="primary">
            My availability
          </LinkButton>
        }
      />

      {outstanding.length > 0 ? (
        <Alert tone="warn" title="Availability needed" className="mb-5">
          You have not told your admin which shows you can work for{" "}
          {outstanding[0].release.label}.{" "}
          <a href="/availability" className="font-semibold underline">
            Fill it in now
          </a>
          .
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Upcoming shows" value={upcoming.length} sub="Next 8, once published" />
        <Stat label="Hours this period" value={formatMinutes(thisPeriodMinutes)} />
        <Stat
          label="Shows this period"
          value={runningThisPeriod.length}
          sub={thisPeriod.anythingPublished ? "Schedule is out" : "Not published yet"}
        />
      </div>

      <Card className="mt-5">
        <CardHeader
          title="Your next shows"
          action={
            <LinkButton href="/schedule" size="sm">
              Full schedule
            </LinkButton>
          }
        />
        {upcoming.length === 0 ? (
          <EmptyState title="No upcoming shows">
            Nothing scheduled yet. Shows appear here once your admin publishes the schedule.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {upcoming.map((s) => (
              <li key={s.showId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{formatDate(s.dateISO)}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <PlatformBadge platform={s.platform} />
                    <SlotBadge slot={s.slot} />
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="tabular text-sm font-medium text-ink">
                    {s.startHM}–{s.endHM}
                  </p>
                  <p className="text-xs text-ink-subtle">
                    {s.alongside ? `with ${s.alongside.name}` : "on your own"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

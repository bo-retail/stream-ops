import { Alert, Card, CardHeader, EmptyState, LinkButton, PageHeader, Stat } from "@/components/ui";
import { PlatformBadge, SlotBadge } from "@/components/show-labels";
import type { AuthUser } from "@/lib/auth/guards";
import { formatDate, formatMinutes } from "@/lib/domain/dates";
import { getOpenReleasesForUser } from "@/lib/server/availability";
import { getEmployeePeriod } from "@/lib/server/schedule";
import { getWeekContext } from "@/lib/server/settings";

export async function EmployeeDashboard({ user }: { user: AuthUser }) {
  const { today, currentWeek, nextWeek } = await getWeekContext();

  const [thisWeek, upcomingWeek, openReleases] = await Promise.all([
    getEmployeePeriod(user.id, currentWeek),
    getEmployeePeriod(user.id, nextWeek),
    getOpenReleasesForUser(user.id),
  ]);

  const now = Date.now();
  // Cancelled shows are dropped: the whole point of a cancellation is that the
  // person does not turn up, so it must not sit in their upcoming list.
  const upcoming = [...thisWeek.shows, ...upcomingWeek.shows]
    .filter((s) => s.status === "SCHEDULED" && s.endsAt.getTime() >= now)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const runningThisWeek = thisWeek.shows.filter((s) => s.status === "SCHEDULED");
  const thisWeekMinutes = runningThisWeek.reduce(
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
        <Stat label="Upcoming shows" value={upcoming.length} sub="This week and next" />
        <Stat label="Hours this week" value={formatMinutes(thisWeekMinutes)} />
        <Stat
          label="Shows this week"
          value={runningThisWeek.length}
          sub={thisWeek.anythingPublished ? "Schedule is out" : "Not published yet"}
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
            {upcoming.slice(0, 8).map((s) => (
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

import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, Radio, Users } from "lucide-react";
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  LinkButton,
  PageHeader,
  Stat,
} from "@/components/ui";
import { BusinessBadge, PlatformBadge } from "@/components/show-labels";
import { MissingReports } from "@/components/missing-reports";
import { cn } from "@/lib/utils";
import { prisma } from "@/lib/db";
import { formatDate, toDbDate } from "@/lib/domain/dates";
import { SLOT_SHORT } from "@/lib/domain/types";
import { getReleaseView } from "@/lib/server/schedule";
import { listReleases } from "@/lib/server/releases";
import { getSettings, getWeekContext } from "@/lib/server/settings";
import { missingReportsSafe } from "@/lib/server/shipping";
import { salesHeadlineSafe } from "@/lib/server/insights";
import { formatChange, formatMoneyShort } from "@/lib/domain/insights";

export async function BossDashboard() {
  const { today } = await getWeekContext();
  const settings = await getSettings();
  const releases = await listReleases(30);
  const missingReports = await missingReportsSafe();

  /*
    Two figures, not ten.

    Revenue answers "are we doing better", and it cannot be read alone —
    volume beside it is what separates a good fortnight from a discounted one.
    Everything else lives on Sales insights; a dashboard that tries to be a
    report stops being glanceable, which is the only thing it is for.

    Fails soft for the same reason the banner does: a summary figure must not
    be what takes down the page it is summarising.
  */
  const sales = await salesHeadlineSafe();

  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // Today's shows come from whatever release happens to cover today, so they are
  // read by date rather than by walking a release.
  const todayRows = await prisma.show.findMany({
    where: { date: toDbDate(today), status: "SCHEDULED" },
    select: {
      id: true,
      date: true,
      business: true,
      platform: true,
      slot: true,
      startsAt: true,
      endsAt: true,
      release: { select: { scheduleStatus: true } },
      assignments: { select: { user: { select: { name: true } } }, orderBy: { seat: "asc" } },
    },
    orderBy: { startsAt: "asc" },
  });

  const now = Date.now();
  const todayShows = todayRows.map((s) => ({
    id: s.id,
    business: s.business,
    platform: s.platform,
    slot: s.slot,
    startHM: clock.format(s.startsAt),
    endHM: clock.format(s.endsAt),
    live: s.startsAt.getTime() <= now && s.endsAt.getTime() >= now,
    done: s.endsAt.getTime() < now,
    published: s.release.scheduleStatus === "PUBLISHED",
    names: s.assignments.map((a) => a.user.name),
  }));
  const liveNow = todayShows.filter((s) => s.live);

  const open = releases.filter((r) => r.status === "OPEN");
  const drafts = releases.filter((r) => r.status === "DRAFT");
  // What the boss is most likely here to work on: the newest release with shows
  // that has not gone out as a schedule yet.
  const planning =
    releases.find((r) => r.showCount > 0 && r.scheduleStatus !== "PUBLISHED") ?? null;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  // Everything waiting on the boss, gathered into one list rather than scattered
  // across the pages that happen to know about each one.
  const actions: { label: string; href: string; tone: "danger" | "warn" | "info" }[] = [];

  for (const release of open) {
    const missing = release.askedCount - release.submittedCount;
    if (missing > 0) {
      actions.push({
        label: `${missing} ${missing === 1 ? "person has" : "people have"} not answered ${release.label}`,
        href: "/admin/requests",
        tone: "warn",
      });
    } else {
      actions.push({
        label: `Everyone has answered ${release.label} — ready to build`,
        href: `/admin/schedule?release=${release.id}`,
        tone: "info",
      });
    }
  }

  for (const release of drafts) {
    actions.push({
      label:
        release.showCount === 0
          ? `${release.label} has no shows in it yet`
          : `${release.label} is built but never sent to the team`,
      href: `/admin/releases/${release.id}`,
      tone: "warn",
    });
  }

  if (releases.length === 0) {
    actions.push({
      label: "No releases yet — start one to ask the team for availability",
      href: "/admin/releases",
      tone: "info",
    });
  }

  const planningView = planning ? await getReleaseView(planning.id) : null;

  // How the work is spread for the release being planned, busiest first, against
  // how much each person offered — an uneven split is usually uneven
  // availability, and showing both side by side says so without being asked.
  const showsPerPerson = planningView
    ? (() => {
        const offeredByUser = new Map<string, number>();
        for (const a of planningView.availability) {
          offeredByUser.set(a.userId, (offeredByUser.get(a.userId) ?? 0) + 1);
        }
        const priorityIds = new Set(planningView.priorities.map((p) => p.userId));
        return planningView.streamers
          .map((s) => ({
            id: s.id,
            name: s.name,
            priority: planningView.release.usePriority && priorityIds.has(s.id),
            offered: offeredByUser.get(s.id) ?? 0,
            shows: planningView.validation.showsByUser[s.id] ?? 0,
          }))
          .sort((a, b) => b.shows - a.shows || a.name.localeCompare(b.name));
      })()
    : [];

  return (
    <>
      <PageHeader
        title={greeting}
        description={`${formatDate(today, "long")}${liveNow.length > 0 ? " · a show is on air right now" : ""}`}
        action={
          <LinkButton href="/admin/releases" variant="primary">
            Releases
          </LinkButton>
        }
      />

      {/* A day that ran shows and never got its reports stops everything
          downstream, and looks exactly like a quiet day if nobody says so. */}
      <div className="mb-5">
        <MissingReports days={missingReports} canDismiss />
      </div>

      {/* The money first, because it is the only thing on this page that says
          whether the last month went well. Two figures: revenue on its own can
          rise while every watch sells for less. */}
      {sales?.hasData ? (
        <Link href="/insights" className="mb-5 block">
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat
              label="Net revenue · last 30 days"
              value={formatMoneyShort(sales.revenueCents)}
              tone={sales.revenue.direction === "up" ? "ok" : sales.revenue.direction === "down" ? "warn" : undefined}
              sub={`${formatChange(sales.revenue)} on the 30 days before`}
            />
            <Stat
              label="Watches sold · last 30 days"
              value={sales.units}
              tone={sales.unitsChange.direction === "up" ? "ok" : sales.unitsChange.direction === "down" ? "warn" : undefined}
              sub={`${formatChange(sales.unitsChange)} on the 30 days before`}
            />
          </div>
        </Link>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Shows today" value={todayShows.length} sub={`${liveNow.length} on air now`} />
        <Stat
          label="People on today"
          value={todayShows.reduce((n, s) => n + s.names.length, 0)}
          sub="Two to a show"
        />
        <Stat
          label="Out with the team"
          value={open.length}
          sub={open.length === 1 ? "1 request open" : `${open.length} requests open`}
        />
        <Stat
          label="Answers in"
          value={
            open.length === 0
              ? "—"
              : `${open.reduce((n, r) => n + r.submittedCount, 0)}/${open.reduce((n, r) => n + r.askedCount, 0)}`
          }
          tone={
            open.length > 0 && open.every((r) => r.submittedCount === r.askedCount)
              ? "ok"
              : undefined
          }
          sub={open.length === 0 ? "Nothing out" : "Across open requests"}
        />
      </div>

      {actions.length > 0 ? (
        <Card className="mt-5">
          <CardHeader
            title="Needs your attention"
            description="Everything waiting on you, in one place."
          />
          <ul className="divide-y divide-line">
            {actions.map((a, i) => (
              <li key={i}>
                <a
                  href={a.href}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-canvas"
                >
                  <span className="flex items-center gap-2.5">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        a.tone === "danger"
                          ? "bg-danger-500"
                          : a.tone === "warn"
                            ? "bg-warn-500"
                            : "bg-brand-500"
                      }`}
                      aria-hidden
                    />
                    <span className="text-ink">{a.label}</span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Alert tone="ok" className="mt-5" title="Nothing needs you right now">
          Nothing is waiting to go out, and every request has been answered.
        </Alert>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Today"
            description={formatDate(today, "long")}
            action={
              liveNow.length > 0 ? (
                <Badge tone="danger">
                  <Radio className="h-3 w-3" aria-hidden />
                  On air
                </Badge>
              ) : null
            }
          />
          {todayShows.length === 0 ? (
            <EmptyState title="No shows today" />
          ) : (
            <ul className="divide-y divide-line">
              {todayShows.map((show) => (
                <li key={show.id} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {/* The one place both kinds of show sit side by side, so
                          the diamond ones have to be tellable at a glance. */}
                      <BusinessBadge business={show.business} />
                      <PlatformBadge platform={show.platform} />
                      <Badge tone={show.slot === "DAY" ? "warn" : "brand"}>
                        {SLOT_SHORT[show.slot]}
                      </Badge>
                      {show.live ? <Badge tone="danger">Live</Badge> : null}
                      {!show.published ? <Badge tone="neutral">Not published</Badge> : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="tabular text-sm font-medium text-ink">
                        {show.startHM}–{show.endHM}
                      </p>
                      <p className="text-xs text-ink-subtle">
                        {show.done ? "finished" : show.live ? "on air" : "upcoming"}
                      </p>
                    </div>
                  </div>
                  <p className="mt-1 text-sm text-ink-muted">
                    {show.names.length === 0 ? "Nobody on it" : show.names.join(" and ")}
                    {show.names.length === 1 ? " — needs one more" : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Requests out"
            description="What the team has been asked for."
            action={
              <LinkButton href="/admin/requests" size="sm">
                Open
              </LinkButton>
            }
          />
          {open.length === 0 ? (
            <EmptyState title="Nothing out with the team">
              Build a release and send it, and the answers land here.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {open.map((release) => {
                const missing = release.askedCount - release.submittedCount;
                return (
                  <li key={release.id} className="space-y-1.5 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-ink">{release.label}</span>
                      <span className="tabular shrink-0 text-sm text-ink-muted">
                        {release.submittedCount}/{release.askedCount}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-ink-muted">
                      {missing > 0 ? (
                        <>
                          <AlertTriangle className="h-4 w-4 shrink-0 text-warn-500" aria-hidden />
                          waiting on {missing}
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-ok-500" aria-hidden />
                          everyone has answered
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-sm text-ink-muted">
                      <Users className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
                      {release.showCount} shows · {release.totalSeats} seats
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {planningView ? (
        <Card className="mt-5">
          <CardHeader
            title="Shows per person"
            description={`${planningView.release.label} — how the work is spread.`}
            action={
              <LinkButton
                href={`/admin/schedule?release=${planningView.release.id}`}
                size="sm"
                variant="ghost"
              >
                Adjust
              </LinkButton>
            }
          />
          {showsPerPerson.length === 0 ? (
            <EmptyState title="Nobody on the team yet">
              Add your streamers, and their load will show here.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line sm:grid sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
              {showsPerPerson.map((person) => (
                <li
                  key={person.id}
                  className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 last:border-b-0 sm:border-b"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{person.name}</p>
                    {person.priority ? (
                      <p className="text-xs text-brand-700">Priority</p>
                    ) : person.offered > 0 ? (
                      <p className="text-xs text-ink-subtle">offered {person.offered}</p>
                    ) : null}
                  </div>
                  <span
                    className={cn(
                      "tabular shrink-0 text-lg font-semibold",
                      person.shows === 0 ? "text-ink-subtle" : "text-ink",
                    )}
                  >
                    {person.shows === 0 ? "—" : person.shows}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FileSpreadsheet } from "lucide-react";
import { Badge, Card, CardHeader, LinkButton, PageHeader, Stat } from "@/components/ui";
import { requireBoss } from "@/lib/auth/guards";
import { BUSINESS_LABEL, BUSINESS_SHORT } from "@/lib/domain/business";
import { checkCandidate } from "@/lib/domain/schedule";
import { SEATS } from "@/lib/domain/types";
import {
  getReleaseView,
  toAssignmentInput,
  toAvailabilityInput,
  toShowInput,
} from "@/lib/server/schedule";
import { listReleases } from "@/lib/server/releases";
import { ScheduleBuilder } from "./builder";
import type { BuilderPerson, BuilderShow, Candidate, CandidateMap } from "./builder";
import { seatKey } from "./seat-key";
import { ReleaseActions } from "./period-actions";

export const metadata: Metadata = { title: "Build schedule" };

export default async function BuildSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ release?: string }>;
}) {
  await requireBoss();
  const { release: releaseParam } = await searchParams;

  const releases = await listReleases(30);
  if (releases.length === 0) {
    return (
      <>
        <PageHeader title="Build schedule" description="Nothing to build yet." />
        <Card>
          <CardHeader
            title="No releases"
            description="A schedule is built from a release — the days, shows and rules you set."
          />
          <div className="p-4">
            <LinkButton href="/admin/releases" variant="primary">
              Make a release
            </LinkButton>
          </div>
        </Card>
      </>
    );
  }

  // Default to the newest release still being worked on, not one already out
  // the door — that is nearly always what the boss came here for.
  const withShows = releases.filter((r) => r.showCount > 0);
  const fallback =
    withShows.find((r) => r.scheduleStatus !== "PUBLISHED") ?? withShows[0] ?? releases[0];
  const chosen = releases.find((r) => r.id === releaseParam) ?? fallback;

  const view = await getReleaseView(chosen.id);
  if (!view) notFound();

  // The inputs the candidate check needs, built once for the whole page.
  const showInputs = view.shows.map(toShowInput);
  const assignmentInputs = view.shows.flatMap((s) =>
    s.assignments.map((a) => toAssignmentInput(s.id, a)),
  );
  const availabilityInputs = view.availability.map(toAvailabilityInput);

  // Warnings the validator raised, indexed so each seat can carry its own.
  const flagBySeat = new Map<string, string>();
  for (const issue of view.validation.warnings) {
    if (!issue.userId || issue.showIds.length === 0 || issue.seat === undefined) continue;
    flagBySeat.set(seatKey(issue.showIds[0], issue.seat), issue.message);
  }

  const shows: BuilderShow[] = view.shows.map((show) => ({
    id: show.id,
    dateISO: show.dateISO,
    platform: show.platform,
    slot: show.slot,
    status: show.status,
    startHM: show.startHM,
    endHM: show.endHM,
    minutes: show.minutes,
    notes: show.notes,
    seats: SEATS.map((seat) => {
      const filled = show.assignments.find((a) => a.seat === seat);
      return {
        seat,
        userId: filled?.userId ?? null,
        userName: filled?.userName ?? null,
        flag: filled ? (flagBySeat.get(seatKey(show.id, seat)) ?? null) : null,
      };
    }),
  }));

  // Candidates for every empty seat. Computed here because the check needs the
  // whole week — a clash on Thursday depends on what is already on Thursday.
  const candidates: CandidateMap = {};
  for (const show of view.shows) {
    if (show.status === "CANCELLED") continue;
    for (const seat of SEATS) {
      if (show.assignments.some((a) => a.seat === seat)) continue;

      const forSeat: Candidate[] = view.streamers.map((person) => {
        const result = checkCandidate(person.id, toShowInput(show), {
          assignments: assignmentInputs,
          shows: showInputs,
          availability: availabilityInputs,
          timeOffByUser: view.timeOffByUser,
          elsewhere: view.elsewhere,
        });
        return {
          userId: person.id,
          name: person.name,
          blocked: result.ok ? null : (result.reason ?? "Not available"),
          warn: result.ok ? (result.reason ?? null) : null,
        };
      });

      // People who can simply take the seat first, then the ones with a caveat,
      // then the ones who cannot — so the obvious choice is at the top.
      forSeat.sort((a, b) => {
        const rank = (c: Candidate) => (c.blocked ? 2 : c.warn ? 1 : 0);
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      });

      candidates[seatKey(show.id, seat)] = forSeat;
    }
  }

  // What each person is carrying, split by platform, counted from the draft as
  // it stands. Cancelled shows are skipped — one needs nobody, so it must not
  // sit in anybody's total — which is the same rule the validator applies to
  // showsByUser, so the two agree.
  const tally = new Map<string, { total: number; tiktok: number; ebay: number }>();
  for (const show of view.shows) {
    if (show.status === "CANCELLED") continue;
    for (const a of show.assignments) {
      const t = tally.get(a.userId) ?? { total: 0, tiktok: 0, ebay: 0 };
      t.total += 1;
      if (show.platform === "TIKTOK") t.tiktok += 1;
      else t.ebay += 1;
      tally.set(a.userId, t);
    }
  }

  const people: BuilderPerson[] = view.streamers.map((s) => {
    const t = tally.get(s.id) ?? { total: 0, tiktok: 0, ebay: 0 };
    return { id: s.id, name: s.name, shows: t.total, tiktok: t.tiktok, ebay: t.ebay };
  });

  const { totalSeats, filledSeats } = view.validation;
  const staffedPct = totalSeats === 0 ? 0 : Math.round((filledSeats / totalSeats) * 100);
  const running = view.shows.filter((s) => s.status === "SCHEDULED").length;
  const cancelled = view.shows.length - running;
  const published = releases.filter((r) => r.scheduleStatus === "PUBLISHED").slice(0, 8);

  // The hours the bulk-edit box starts on: whatever this release's shows
  // actually run, rather than a default that may be nothing like them.
  const firstDay = view.shows.find((s) => s.slot === "DAY");
  const firstNight = view.shows.find((s) => s.slot === "NIGHT");
  const slotHours = {
    DAY: { start: firstDay?.startHM ?? "13:00", end: firstDay?.endHM ?? "19:00" },
    NIGHT: { start: firstNight?.startHM ?? "19:00", end: firstNight?.endHM ?? "01:00" },
  };

  return (
    <>
      <PageHeader
        title="Build schedule"
        // An unnamed release is known by its dates, so its label already *is*
        // the date range — printing both read "Sep 16 – Sep 30 · Sep 16 – Sep 30".
        description={
          // Which kind of show leads, because two releases can cover the same
          // fortnight and the dates alone would read as a duplicate.
          `${BUSINESS_LABEL[view.release.business]} · ` +
          (view.release.label === view.release.dateRange
            ? view.release.dateRange
            : `${view.release.label} · ${view.release.dateRange}`)
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {view.release.scheduleStatus === "PUBLISHED" ? (
              <Badge tone="ok">Published · v{view.release.version}</Badge>
            ) : (
              <Badge tone="warn">Draft</Badge>
            )}
            <a
              href={`/api/schedule/export?release=${view.release.id}`}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-canvas"
            >
              <FileSpreadsheet className="h-4 w-4" aria-hidden />
              Download Excel
            </a>
          </div>
        }
      />

      {/* Releases are whatever length the boss made them, so there is no "next"
          to step to — the list is the only honest way to move between them. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {releases.slice(0, 6).map((r) => (
          <LinkButton
            key={r.id}
            href={`/admin/schedule?release=${r.id}`}
            size="sm"
            variant={r.id === view.release.id ? "primary" : "ghost"}
          >
            {/* Two releases can share a label when they share dates, so the
                kind of show is the only thing that tells these buttons apart. */}
            {BUSINESS_SHORT[r.business]} · {r.label}
          </LinkButton>
        ))}
        <LinkButton href={`/admin/releases/${view.release.id}`} size="sm" variant="secondary">
          Edit this release
        </LinkButton>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Seats filled"
          value={`${filledSeats}/${totalSeats}`}
          tone={totalSeats > 0 && staffedPct === 100 ? "ok" : "danger"}
          sub={`${staffedPct}% of the release`}
        />
        <Stat
          label="Still to fill"
          value={totalSeats - filledSeats}
          tone={filledSeats === totalSeats ? "ok" : "warn"}
          sub={filledSeats === totalSeats ? "Nothing empty" : "You can publish anyway"}
        />
        <Stat
          label="Shows running"
          value={running}
          sub={cancelled > 0 ? `${cancelled} cancelled` : "None cancelled"}
        />
        <Stat
          label="Availability in"
          value={`${view.submittedUserIds.length}/${view.streamers.length}`}
          tone={
            view.streamers.length > 0 && view.submittedUserIds.length === view.streamers.length
              ? "ok"
              : undefined
          }
          sub={
            view.release.status === "OPEN"
              ? "Still taking answers"
              : view.release.status === "DRAFT"
                ? "Not sent out yet"
                : "Closed"
          }
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_21rem]">
        <div className="order-2 lg:order-1">
          <ScheduleBuilder
            dates={view.dates}
            shows={shows}
            people={people}
            candidates={candidates}
          />
        </div>

        <div className="order-1 space-y-5 lg:order-2">
          <ReleaseActions
            releaseId={view.release.id}
            errors={view.validation.errors.map((e) => e.message)}
            // Open seats get their own line, driven by the count — listing 100
            // near-identical "needs two people" messages buries everything else.
            warnings={view.validation.warnings
              .filter((w) => w.code !== "UNSTAFFED")
              .map((w) => w.message)}
            canPublish={view.validation.canPublish}
            openSeats={view.validation.openSeats}
            alreadyPublished={view.release.scheduleStatus === "PUBLISHED"}
            version={view.release.version}
            rules={{
              usePriority: view.release.usePriority,
              useProportional: view.release.useProportional,
              priorityNames: view.priorities.map((p) => p.name),
              maxShowsPerPerson: view.release.maxShowsPerPerson,
            }}
            slotHours={slotHours}
          />

          <Card>
            <CardHeader
              title="Recently published"
              description="Past schedules are kept, never overwritten."
            />
            <ul className="divide-y divide-line">
              {published.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm"
                >
                  <a
                    href={`/admin/schedule?release=${r.id}`}
                    className="font-medium text-ink hover:underline"
                  >
                    {r.label}
                  </a>
                  <span className="shrink-0 text-xs text-ink-subtle">v{r.version}</span>
                </li>
              ))}
              {published.length === 0 ? (
                <li className="px-4 py-3 text-sm text-ink-muted">Nothing published yet.</li>
              ) : null}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

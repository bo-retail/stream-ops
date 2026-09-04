import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card, CardHeader, LinkButton, PageHeader, Stat } from "@/components/ui";
import { requireBoss } from "@/lib/auth/guards";
import { datesBetween, fromDbDate } from "@/lib/domain/dates";
import { prisma } from "@/lib/db";
import { getPriorities, getReleaseSummary } from "@/lib/server/releases";
import { getSettings } from "@/lib/server/settings";
import { listStreamers } from "@/lib/server/team";
import { Composer, ReleaseControls, StatusBadge } from "../composer";
import type { ExistingShow } from "../composer";

export const metadata: Metadata = { title: "Release" };

export default async function ReleasePage({ params }: { params: Promise<{ id: string }> }) {
  await requireBoss();
  const { id } = await params;

  const release = await getReleaseSummary(id);
  if (!release) notFound();

  const settings = await getSettings();
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const [showRows, streamers, priorities] = await Promise.all([
    prisma.show.findMany({
      where: { releaseId: id },
      select: {
        date: true,
        platform: true,
        slot: true,
        startsAt: true,
        endsAt: true,
        _count: { select: { assignments: true } },
      },
      orderBy: [{ date: "asc" }, { startsAt: "asc" }],
    }),
    listStreamers(),
    getPriorities(id),
  ]);

  const existing: ExistingShow[] = showRows.map((s) => ({
    dateISO: fromDbDate(s.date),
    platform: s.platform,
    slot: s.slot,
    startHM: clock.format(s.startsAt),
    endHM: clock.format(s.endsAt),
    staffed: s._count.assignments > 0,
  }));

  const dates = datesBetween(release.startDate, release.endDate);

  // Once a schedule is published the shows are being worked to, so the grid
  // becomes read-only and changes go through the schedule page instead, where
  // cancelling a show tells everyone rather than quietly deleting it.
  const editable = release.scheduleStatus !== "PUBLISHED";

  return (
    <>
      <PageHeader
        title={release.label}
        description={`${release.dateRange} · ${release.days} day${release.days === 1 ? "" : "s"}`}
        action={
          <div className="flex gap-2">
            <LinkButton href="/admin/releases" size="sm" variant="ghost">
              All releases
            </LinkButton>
            {release.showCount > 0 ? (
              <LinkButton href={`/admin/schedule?release=${release.id}`} size="sm" variant="primary">
                Build schedule
              </LinkButton>
            ) : null}
          </div>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Status" value={<StatusBadge status={release.status} />} />
        <Stat label="Shows" value={release.showCount} sub={`${release.totalSeats} seats`} />
        <Stat
          label="Answered"
          value={`${release.submittedCount}/${release.askedCount}`}
          tone={
            release.status !== "DRAFT" && release.submittedCount === release.askedCount
              ? "ok"
              : undefined
          }
          sub={release.status === "DRAFT" ? "Not sent yet" : "Sent in"}
        />
        <Stat
          label="Seats filled"
          value={`${release.filledSeats}/${release.totalSeats}`}
          tone={
            release.totalSeats > 0 && release.filledSeats === release.totalSeats ? "ok" : undefined
          }
        />
      </div>

      {!editable ? (
        <Alert tone="info" className="mb-5" title="The schedule for this release is published">
          The shows are read-only here now. Change one on the{" "}
          <a href={`/admin/schedule?release=${release.id}`} className="font-semibold underline">
            schedule page
          </a>
          , where cancelling tells the people on it.
        </Alert>
      ) : null}

      <Card className="mb-5">
        <CardHeader
          title="Send it out"
          description={
            release.status === "DRAFT"
              ? "Nobody sees this until you send it."
              : release.status === "OPEN"
                ? "The team can fill this in right now."
                : "Closed. Nobody can change their answer."
          }
        />
        <div className="p-4">
          <ReleaseControls
            releaseId={release.id}
            status={release.status}
            showCount={release.showCount}
          />
        </div>
      </Card>

      <Composer
        releaseId={release.id}
        dates={dates}
        existing={existing}
        streamers={streamers.map((s) => ({ id: s.id, name: s.name }))}
        rules={{
          usePriority: release.usePriority,
          useProportional: release.useProportional,
          maxShowsPerPerson: release.maxShowsPerPerson,
          priorityUserIds: priorities.map((p) => p.userId),
        }}
        editable={editable}
      />
    </>
  );
}

import type { Metadata } from "next";
import { Badge, Card, CardHeader, EmptyState, LinkButton, PageHeader, Stat } from "@/components/ui";
import { requireBoss } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { listReleases } from "@/lib/server/releases";
import { listStreamers } from "@/lib/server/team";
import { AnswerList } from "./requests-client";
import type { PersonAnswer } from "./requests-client";
import { StatusBadge } from "../releases/composer";

export const metadata: Metadata = { title: "Requests" };

export default async function RequestsPage() {
  await requireBoss();

  const [releases, streamers] = await Promise.all([listReleases(30), listStreamers()]);
  const asked = releases.filter((r) => r.status !== "DRAFT");

  // Everything answered, in one query rather than one per release.
  const ids = asked.map((r) => r.id);
  const [submissions, picks] = await Promise.all([
    ids.length > 0
      ? prisma.availabilitySubmission.findMany({
          where: { releaseId: { in: ids } },
          select: { releaseId: true, userId: true, submittedAt: true },
        })
      : Promise.resolve([]),
    ids.length > 0
      ? prisma.availability.groupBy({
          by: ["releaseId", "userId"],
          where: { releaseId: { in: ids } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  const submittedBy = new Map(
    submissions.map((s) => [`${s.releaseId}|${s.userId}`, s.submittedAt]),
  );
  const offeredBy = new Map(picks.map((p) => [`${p.releaseId}|${p.userId}`, p._count._all]));

  const open = asked.filter((r) => r.status === "OPEN");
  const closed = asked.filter((r) => r.status === "CLOSED");

  function peopleFor(releaseId: string): PersonAnswer[] {
    return streamers
      .map((s) => {
        const submittedAt = submittedBy.get(`${releaseId}|${s.id}`) ?? null;
        return {
          userId: s.id,
          name: s.name,
          submitted: submittedAt !== null,
          submittedAt,
          offered: offeredBy.get(`${releaseId}|${s.id}`) ?? 0,
        };
      })
      // Who you are waiting on first — that is the reason to open this page.
      .sort((a, b) => Number(a.submitted) - Number(b.submitted) || a.name.localeCompare(b.name));
  }

  const waitingOn = open.reduce((n, r) => n + (r.askedCount - r.submittedCount), 0);

  return (
    <>
      <PageHeader
        title="Requests"
        description="What you have asked the team for, and what has come back."
        action={
          <LinkButton href="/admin/releases" variant="primary">
            New release
          </LinkButton>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Stat label="Out with the team" value={open.length} sub="Taking answers now" />
        <Stat
          label="Waiting on"
          value={waitingOn}
          tone={open.length > 0 && waitingOn === 0 ? "ok" : waitingOn > 0 ? "warn" : undefined}
          sub={waitingOn === 1 ? "1 person" : `${waitingOn} people`}
        />
        <Stat label="Asked, all time" value={asked.length} />
      </div>

      {asked.length === 0 ? (
        <Card>
          <EmptyState title="You have not asked for anything yet">
            Build a release and send it out — the answers appear here.
          </EmptyState>
        </Card>
      ) : null}

      {open.length > 0 ? (
        <div className="space-y-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-subtle">
            Out there now
          </h2>
          {open.map((release) => (
            <Card key={release.id}>
              <CardHeader
                title={release.label}
                description={`${release.dateRange} · ${release.showCount} shows · ${release.submittedCount} of ${release.askedCount} answered${
                  release.dueAt ? ` · due ${release.dueAt.toLocaleDateString("en-US")}` : ""
                }`}
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={release.status} />
                    <LinkButton href={`/admin/schedule?release=${release.id}`} size="sm">
                      Build
                    </LinkButton>
                  </div>
                }
              />
              <AnswerList releaseId={release.id} people={peopleFor(release.id)} canReopen />
            </Card>
          ))}
        </div>
      ) : null}

      {closed.length > 0 ? (
        <div className="mt-8 space-y-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-subtle">
            Already asked
          </h2>
          {closed.map((release) => (
            <Card key={release.id}>
              <CardHeader
                title={release.label}
                description={`${release.dateRange} · ${release.submittedCount} of ${release.askedCount} answered · ${release.filledSeats}/${release.totalSeats} seats filled`}
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    {release.scheduleStatus === "PUBLISHED" ? (
                      <Badge tone="brand">Published v{release.version}</Badge>
                    ) : (
                      <StatusBadge status={release.status} />
                    )}
                    <LinkButton href={`/admin/schedule?release=${release.id}`} size="sm">
                      Open
                    </LinkButton>
                  </div>
                }
              />
              <AnswerList
                releaseId={release.id}
                people={peopleFor(release.id)}
                canReopen={release.scheduleStatus !== "PUBLISHED"}
              />
            </Card>
          ))}
        </div>
      ) : null}
    </>
  );
}

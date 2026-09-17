import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
import { requireBoss } from "@/lib/auth/guards";
import { BUSINESS_SHORT } from "@/lib/domain/business";
import { addDays } from "@/lib/domain/dates";
import { listReleases } from "@/lib/server/releases";
import { getWeekContext } from "@/lib/server/settings";
import { NewReleaseForm } from "./new-release";
import { StatusBadge } from "./composer";

export const metadata: Metadata = { title: "Releases" };

export default async function ReleasesPage() {
  await requireBoss();
  const { today } = await getWeekContext();
  const releases = await listReleases();

  const open = releases.filter((r) => r.status === "OPEN");
  const drafts = releases.filter((r) => r.status === "DRAFT");

  return (
    <>
      <PageHeader
        title="Releases"
        description="Each one is a request for availability: the days it covers, the shows on them, and the rules for it."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Stat label="Out with the team" value={open.length} sub="Taking answers now" />
        <Stat label="Drafts" value={drafts.length} sub="Not sent yet" />
        <Stat label="All time" value={releases.length} />
      </div>

      <div className="mb-5">
        <NewReleaseForm defaultStart={addDays(today, 1)} defaultEnd={addDays(today, 14)} />
      </div>

      <Card>
        <CardHeader title="Every release" description="Newest first." />
        {releases.length === 0 ? (
          <EmptyState title="No releases yet">
            Start one above. Nothing is asked of the team until you send it.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {releases.map((release) => (
              <li key={release.id}>
                <Link
                  href={`/admin/releases/${release.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-canvas"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">{release.label}</span>
                      {/* Two releases can cover the same fortnight, one of
                          each kind, so this is what tells them apart in a list
                          where the dates are identical. */}
                      <Badge tone={release.business === "DIAMOND" ? "brand" : "neutral"}>
                        {BUSINESS_SHORT[release.business]}
                      </Badge>
                      <StatusBadge status={release.status} />
                      {release.scheduleStatus === "PUBLISHED" ? (
                        <Badge tone="brand">Schedule published v{release.version}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {release.name ? `${release.dateRange} · ` : ""}
                      {release.days} day{release.days === 1 ? "" : "s"} ·{" "}
                      {release.showCount} show{release.showCount === 1 ? "" : "s"}
                      {release.status !== "DRAFT"
                        ? ` · ${release.submittedCount}/${release.askedCount} answered`
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular text-right text-sm text-ink-muted">
                      {release.filledSeats}/{release.totalSeats}
                      <span className="block text-xs text-ink-subtle">seats</span>
                    </span>
                    <ArrowRight className="h-4 w-4 text-ink-subtle" aria-hidden />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card, CardHeader, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requireStreamer } from "@/lib/auth/guards";
import { addDays } from "@/lib/domain/dates";
import {
  getAvailabilityForRelease,
  getDefaultRelease,
  getOpenReleasesForUser,
} from "@/lib/server/availability";
import { getWeekContext } from "@/lib/server/settings";
import { getTimeOffInRange } from "@/lib/server/timeOff";
import { AvailabilityEditor, SubmitAvailability } from "./availability-client";
import type { SlotOption } from "./availability-client";
import { TimeOffPanel } from "./time-off-panel";

export const metadata: Metadata = { title: "My availability" };

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ release?: string }>;
}) {
  const user = await requireStreamer();
  const { today } = await getWeekContext();
  const { release: releaseParam } = await searchParams;

  const openReleases = await getOpenReleasesForUser(user.id);
  const fallback = await getDefaultRelease(user.id);

  // Only requests the boss has actually sent out can be opened here.
  const start =
    releaseParam && openReleases.some((r) => r.release.id === releaseParam)
      ? releaseParam
      : fallback;

  const timeOff = await getTimeOffInRange({
    from: today,
    to: addDays(today, 120),
    userId: user.id,
  });

  if (!start) {
    return (
      <>
        <PageHeader
          title="My availability"
          description="Tell your admin which shows you can work."
        />
        <Card>
          <EmptyState title="Nothing to fill in yet">
            Your admin has not asked for your availability yet. You will be able to fill it in here
            as soon as they do.
          </EmptyState>
        </Card>
        <div className="mt-5">
          <TimeOffPanel entries={timeOff} today={today} />
        </div>
      </>
    );
  }

  const availability = await getAvailabilityForRelease(user.id, start);
  if (!availability) notFound();
  const release = availability.release;

  const options: SlotOption[] = availability.options.map((o) => ({
    dateISO: o.dateISO,
    slot: o.slot,
    startHM: o.startHM,
    endHM: o.endHM,
    cancelled: o.cancelled,
    offered: availability.picks.some((p) => p.dateISO === o.dateISO && p.slot === o.slot),
  }));

  const due = availability.dueAt;
  const offeredCount = availability.picks.length;

  return (
    <>
      <PageHeader
        title="My availability"
        description={`Tap the shows you can work — ${release.label} (${release.dateRange}).`}
      />

      {openReleases.length > 1 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {openReleases.map((r) => (
            <LinkButton
              key={r.release.id}
              href={`/availability?release=${r.release.id}`}
              size="sm"
              variant={r.release.id === start ? "primary" : "secondary"}
            >
              {r.release.label}
              {r.submitted ? " ✓" : ""}
            </LinkButton>
          ))}
        </div>
      ) : null}

      {due ? (
        <Alert
          tone={availability.isLate ? "danger" : "info"}
          className="mb-4"
          title={availability.isLate ? "This is overdue" : undefined}
        >
          Your admin would like this in by {due.toLocaleString("en-US")}.
        </Alert>
      ) : null}

      {availability.locked ? (
        <Alert tone="info" className="mb-4" title="This schedule is published">
          The schedule is built, so availability is now read-only. Check{" "}
          <a href="/schedule" className="font-semibold underline">
            My schedule
          </a>{" "}
          to see your shows.
        </Alert>
      ) : availability.submitted ? (
        <Alert tone="ok" className="mb-4" title="Sent in">
          {offeredCount} show{offeredCount === 1 ? "" : "s"} offered for {release.label}. This
          is locked now — if something has changed, ask your admin to reopen it.
        </Alert>
      ) : (
        <Alert tone="warn" className="mb-4" title="Not sent in yet">
          Tap the shows you can work — day, night, or both, on any day. Your taps are saved as you
          go, so you can come back to it. Nothing reaches your admin until you press{" "}
          <strong>Send in</strong> at the bottom.
        </Alert>
      )}

      <AvailabilityEditor
        key={release.id}
        releaseId={release.id}
        dates={availability.dates}
        options={options}
        daysOff={availability.daysOff}
        locked={availability.locked || !availability.isOpen || availability.submitted}
      />

      {!availability.locked && availability.isOpen && !availability.submitted ? (
        <div className="mt-5">
          <SubmitAvailability
            releaseId={release.id}
            releaseLabel={release.label}
            offeredCount={offeredCount}
            dayCount={availability.dates.length}
          />
        </div>
      ) : null}

      <div className="mt-6">
        <Card>
          <CardHeader
            title="Time off"
            description="Whole days you cannot work — holidays, appointments, anything."
          />
          <div className="p-4">
            <TimeOffPanel entries={timeOff} today={today} embedded />
          </div>
        </Card>
      </div>
    </>
  );
}

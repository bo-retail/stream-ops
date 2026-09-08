import type { Metadata } from "next";
import { FileSpreadsheet } from "lucide-react";
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  LinkButton,
  PageHeader,
  Stat,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { PlatformBadge, SlotBadge } from "@/components/show-labels";
import { requireStreamer } from "@/lib/auth/guards";
import { formatDate, formatMinutes, isDateISO } from "@/lib/domain/dates";
import { formatPeriod, formatPeriodShort, nextPeriod, periodFor, previousPeriod } from "@/lib/domain/periods";
import { getEmployeePeriod } from "@/lib/server/schedule";
import { getWeekContext } from "@/lib/server/settings";

export const metadata: Metadata = { title: "My schedule" };

export default async function MySchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const user = await requireStreamer();
  const { today } = await getWeekContext();
  const { period: periodParam } = await searchParams;

  const target = periodParam && isDateISO(periodParam) ? periodParam : today;
  const schedule = await getEmployeePeriod(user.id, target);
  const period = schedule.period;
  const periodLabel = formatPeriod(period);

  const running = schedule.shows.filter((s) => s.status === "SCHEDULED");
  const totalMinutes = running.reduce(
    (m, s) => m + Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000),
    0,
  );

  return (
    <>
      <PageHeader
        title="My schedule"
        description={periodLabel}
        action={
          schedule.anythingPublished ? (
            <a
              href={`/api/my-schedule/export?period=${period.start}`}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-canvas"
            >
              <FileSpreadsheet className="h-4 w-4" aria-hidden />
              Download
            </a>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <LinkButton
          href={`/schedule?period=${previousPeriod(period).start}`}
          size="sm"
          variant="secondary"
        >
          ← {formatPeriodShort(previousPeriod(period))}
        </LinkButton>
        <LinkButton
          href={`/schedule?period=${nextPeriod(period).start}`}
          size="sm"
          variant="secondary"
        >
          {formatPeriodShort(nextPeriod(period))} →
        </LinkButton>
        {period.start !== periodFor(today).start ? (
          <LinkButton href="/schedule" size="sm" variant="ghost">
            This period
          </LinkButton>
        ) : null}
      </div>

      {!schedule.anythingPublished ? (
        <Alert tone="info" title="Not published yet">
          The schedule for this period has not been published. You will see your shows here as soon as
          your admin publishes it — make sure your{" "}
          <a href="/availability" className="font-semibold underline">
            availability
          </a>{" "}
          is in.
        </Alert>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Shows this period" value={running.length} />
            <Stat label="Total hours" value={formatMinutes(totalMinutes)} />
            <Stat
              label="Cancelled"
              value={schedule.shows.length - running.length}
              sub={
                schedule.shows.length === running.length
                  ? "Everything is running"
                  : "You do not need to work these"
              }
            />
          </div>

          <Card className="mt-5">
            <CardHeader
              title="Your shows"
              description="You and the other person split each show between camera and computer, swapping halfway."
            />
            {schedule.shows.length === 0 ? (
              <EmptyState title="You are not on any shows this period">
                Nothing scheduled. If that looks wrong, check with your admin.
              </EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Show</Th>
                    <Th>Time</Th>
                    <Th>With</Th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.shows.map((s) => (
                    <tr key={s.showId} className={s.status === "CANCELLED" ? "opacity-60" : ""}>
                      <Td className="whitespace-nowrap font-medium">{formatDate(s.dateISO)}</Td>
                      <Td>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <PlatformBadge platform={s.platform} />
                          <SlotBadge slot={s.slot} />
                          {s.status === "CANCELLED" ? (
                            <Badge tone="neutral">Cancelled</Badge>
                          ) : null}
                        </span>
                      </Td>
                      <Td className="tabular whitespace-nowrap">
                        {s.startHM}–{s.endHM}
                      </Td>
                      <Td className="text-ink-muted">
                        {s.alongside?.name ?? "Nobody yet"}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </>
  );
}

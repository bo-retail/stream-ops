import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Stat,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { addDays, formatDate, isDateISO, toDbDate } from "@/lib/domain/dates";
import {
  getDayCounters,
  getPackerDays,
  listIncompleteBoxes,
  listOpenBoxes,
  listUnrecognisedBoxes,
} from "@/lib/server/packing";
import { PLATFORM_SHORT } from "@/lib/domain/types";
import { packingDayISO } from "@/lib/server/shipping";
import { getSettings } from "@/lib/server/settings";
import { MarkDaySent } from "./mark-sent";

export const metadata: Metadata = { title: "Shipping log" };

/**
 * The day's counters, who packed what, and the exceptions.
 *
 * Opens on yesterday rather than today: yesterday's shows are packed this
 * morning, so the day that matters when this is opened is almost always the one
 * before. Any past date can be pulled up — the scan record is permanent.
 *
 * Not open to packers. The box in front of them is their screen.
 */
export default async function ShippingLogPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  await requireShippingDirector();

  const params = await searchParams;
  const fallback = await packingDayISO();
  const dateISO = params.date && isDateISO(params.date) ? params.date : fallback;
  const showDate = toDbDate(dateISO);
  const settings = await getSettings();

  const [counters, packers, incomplete, unrecognised, openBoxes] = await Promise.all([
    getDayCounters(showDate, dateISO),
    getPackerDays(showDate),
    listIncompleteBoxes(showDate),
    listUnrecognisedBoxes(showDate),
    listOpenBoxes(showDate),
  ]);

  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const time = (at: Date | null) => (at ? clock.format(at) : "—");

  const toGo = Math.max(0, counters.total - counters.sent);
  const link = (d: string) => `/shipping/log?date=${d}`;

  return (
    <>
      <PageHeader
        title="Shipping log"
        description={`Packing the shows of ${formatDate(dateISO, "long")}.`}
        action={
          <div className="flex items-center gap-2">
            <Link
              href={link(addDays(dateISO, -1))}
              className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas"
            >
              ← Previous day
            </Link>
            {dateISO !== fallback ? (
              <Link
                href={link(fallback)}
                className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas"
              >
                Yesterday
              </Link>
            ) : null}
            <Link
              href={link(addDays(dateISO, 1))}
              className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas"
            >
              Next day →
            </Link>
          </div>
        }
      />

      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Boxes sent"
            value={counters.total === 0 ? "—" : `${counters.sent} of ${counters.total}`}
            tone={counters.total > 0 && counters.sent === counters.total ? "ok" : undefined}
            sub={counters.total === 0 ? "No report loaded for this day" : `${toGo} still to go`}
          />
          <Stat label="People packing" value={packers.length || "—"} sub="From their scans" />
          <Stat
            label="Incomplete"
            value={counters.incomplete || "—"}
            tone={counters.incomplete > 0 ? "warn" : undefined}
            sub={counters.incomplete > 0 ? "Went out short or with extras" : "None"}
          />
          {counters.unverified > 0 ? (
            <Stat
              label="Not scanned here"
              value={counters.unverified}
              tone="warn"
              sub="Marked sent without being checked"
            />
          ) : (
            <Stat
              label="Unrecognised labels"
              value={counters.unrecognised || "—"}
              tone={counters.unrecognised > 0 ? "warn" : undefined}
              sub={counters.unrecognised > 0 ? "Not in any report" : "None"}
            />
          )}
        </div>

        {/*
          The labels nobody has scanned yet, by tracking number.

          A count cannot be acted on. On 09/10–11 sixteen labels were never
          scanned; every one of them had shipped, and nothing on this screen
          could show that. With the numbers the director can check the stack or
          look one up the same morning. Collapsed, because first thing it is the
          whole day.
        */}
        {openBoxes.length > 0 ? (
          <Card>
            <details>
              <summary className="cursor-pointer px-4 py-3 sm:px-5">
                <span className="text-sm font-semibold text-ink">
                  Labels not scanned yet ({openBoxes.length})
                </span>
                <span className="block text-sm text-ink-muted">
                  Every box from the report that is still open, by tracking number.
                </span>
              </summary>
              <Table>
                <thead>
                  <tr>
                    <Th>Tracking</Th>
                    <Th>Marketplace</Th>
                    <Th>Buyer</Th>
                    <Th>Watches</Th>
                    <Th>Scanned so far</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {openBoxes.map((b) => (
                    <tr key={b.id}>
                      <Td className="tabular text-xs">{b.tracking}</Td>
                      <Td className="text-ink-muted">{PLATFORM_SHORT[b.platform]}</Td>
                      <Td className="text-ink-muted">{b.buyer || "—"}</Td>
                      <Td className="tabular">{b.expected}</Td>
                      <Td className="tabular text-ink-muted">{b.scanned || "—"}</Td>
                      <Td className="text-right">
                        <Link
                          href={`/shipping/log/box/${b.id}`}
                          className="text-sm font-medium text-brand-700 underline underline-offset-2"
                        >
                          Every scan
                        </Link>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </details>
          </Card>
        ) : null}

        <MarkDaySent
          dateISO={dateISO}
          dayLabel={formatDate(dateISO, "long")}
          openBoxes={toGo}
        />

        <Card>
          <CardHeader
            title="Download the shipping report"
            description="This day, or a range. Three sheets: who packed what, every box, and every scan."
          />
          <div className="flex flex-wrap items-end gap-3 p-4">
            <a
              href={`/api/shipping/export?date=${dateISO}`}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Download className="h-4 w-4" aria-hidden />
              This day
            </a>
            {/* A plain GET form: the browser navigates and the file arrives. */}
            <form action="/api/shipping/export" method="get" className="flex flex-wrap items-end gap-3">
              <Field label="From" htmlFor="from">
                <Input id="from" name="from" type="date" defaultValue={dateISO} required />
              </Field>
              <Field label="To" htmlFor="to">
                <Input id="to" name="to" type="date" defaultValue={dateISO} required />
              </Field>
              <Button type="submit" variant="secondary">
                <Download className="h-4 w-4" aria-hidden />
                Download range
              </Button>
            </form>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Who packed what"
            description="Activity, not a timesheet — first and last scan bracket when somebody was actually packing."
          />
          {packers.length === 0 ? (
            <EmptyState title="Nothing packed on this day">
              Boxes appear here as they are closed.
            </EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th>Boxes</Th>
                  <Th>Watches</Th>
                  <Th>First scan</Th>
                  <Th>Last scan</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {packers.map((p) => (
                  <tr key={p.userId}>
                    <Td className="font-medium">
                      <Link
                        href={`/shipping/log/person/${p.userId}?date=${dateISO}`}
                        className="text-brand-700 underline underline-offset-2"
                      >
                        {p.name}
                      </Link>
                    </Td>
                    <Td className="tabular">{p.boxes}</Td>
                    <Td className="tabular">{p.items}</Td>
                    <Td className="tabular text-ink-muted">{time(p.firstScan)}</Td>
                    <Td className="tabular text-ink-muted">{time(p.lastScan)}</Td>
                    <Td className="text-right">
                      <Link
                        href={`/shipping/log/person/${p.userId}?date=${dateISO}`}
                        className="text-sm font-medium text-brand-700 underline underline-offset-2"
                      >
                        What they sent
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Incomplete boxes"
            description="Closed short, or with something added against the report."
          />
          {incomplete.length === 0 ? (
            <EmptyState title="None">Every box that went out matched its report.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Tracking</Th>
                  <Th>Buyer</Th>
                  <Th>In the box</Th>
                  <Th>Packed by</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {incomplete.map((b) => (
                  <tr key={b.id}>
                    <Td className="tabular text-xs">{b.tracking}</Td>
                    <Td className="text-ink-muted">{b.buyer || "—"}</Td>
                    <Td className="tabular">
                      <span className={b.scanned < b.expected ? "font-medium text-warn-700" : "font-medium text-ink"}>
                        {b.scanned} of {b.expected}
                      </span>
                    </Td>
                    <Td className="text-ink-muted">{b.closedByName ?? "—"}</Td>
                    <Td className="text-right">
                      <Link
                        href={`/shipping/log/box/${b.id}`}
                        className="text-sm font-medium text-brand-700 underline underline-offset-2"
                      >
                        Every scan
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Unrecognised labels"
            description="Packed from a label that was in no uploaded report. Worth finding out why."
          />
          {unrecognised.length === 0 ? (
            <EmptyState title="None">Every label scanned was in a report.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Tracking</Th>
                  <Th>Watches in it</Th>
                  <Th>Status</Th>
                  <Th>Packed by</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {unrecognised.map((b) => (
                  <tr key={b.id}>
                    <Td className="tabular text-xs">{b.tracking}</Td>
                    <Td className="tabular">{b.scanned}</Td>
                    <Td>
                      {b.status === "OPEN" ? (
                        <Badge tone="warn">Still open</Badge>
                      ) : (
                        <Badge tone="neutral">Sent</Badge>
                      )}
                    </Td>
                    <Td className="text-ink-muted">{b.closedByName ?? "—"}</Td>
                    <Td className="text-right">
                      <Link
                        href={`/shipping/log/box/${b.id}`}
                        className="text-sm font-medium text-brand-700 underline underline-offset-2"
                      >
                        Every scan
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

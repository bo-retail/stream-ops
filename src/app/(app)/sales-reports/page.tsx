import type { Metadata } from "next";
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
  Table,
  Td,
  Th,
} from "@/components/ui";
import { MissingReports } from "@/components/missing-reports";
import { requireShippingDirector } from "@/lib/auth/guards";
import { formatDate } from "@/lib/domain/dates";
import { PLATFORM_SHORT, SLOT_SHORT } from "@/lib/domain/types";
import { listShowDays, missingReports } from "@/lib/server/shipping";
import type { DayShow } from "@/lib/server/shipping";
import { RemoveReport } from "./remove-report";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Sales report entry" };

/** "TikTok Night · eBay Night", cancelled ones struck through. */
function shows(list: DayShow[]) {
  if (list.length === 0) return <span className="text-ink-subtle">—</span>;
  return (
    <span className="text-sm">
      {list.map((s, i) => (
        <span key={`${s.platform}-${s.slot}`}>
          {i > 0 ? <span className="text-ink-subtle"> · </span> : null}
          <span className={s.cancelled ? "text-ink-subtle line-through" : "text-ink"}>
            {PLATFORM_SHORT[s.platform]} {SLOT_SHORT[s.slot]}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * Where the day's exports come in.
 *
 * The list is built from the published schedule, so it says which days ran
 * shows and therefore which days are waiting for something — and, per day,
 * exactly what that something is. Two TikTok shows means two TikTok exports;
 * eBay is always one file however many shows ran, because its report cannot be
 * filtered any finer than a day.
 *
 * The day is chosen here and read out of the orders as well. The choice is only
 * ever a confirmation: if the files say a different day, nothing is imported.
 */
export default async function SalesReportsPage() {
  // The director loads the files; the sales figures behind them are the boss's.
  const user = await requireShippingDirector();
  const isBoss = user.role === "BOSS";
  const [days, missing] = await Promise.all([listShowDays(), missingReports()]);

  const targets = days
    .filter((d) => d.liveShows > 0)
    .map((d) => ({
      dateISO: d.dateISO,
      expects: d.expected.describe,
      // A day loaded without one of its marketplaces is still waiting, so it is
      // not "loaded" for the purpose of choosing what to upload next.
      loaded: d.report?.status === "OK" && d.missing === null,
      partial: d.report?.status === "OK" ? d.missing : null,
    }));

  return (
    <>
      <PageHeader
        title="Sales report entry"
        description="The exports for a show day, and what each day is still waiting for."
      />

      <div className="space-y-5">
        <MissingReports days={missing} />

        <UploadForm targets={targets} />

        {isBoss ? (
          <Card>
            <CardHeader
              title="Download the sales workbook"
              description="A single day from the table below, or a range here — a pay period, a month."
            />
            {/* A plain GET form: the browser navigates to the export and the
                file arrives. Nothing to go wrong client-side. */}
            <form action="/api/sales/export" method="get" className="flex flex-wrap items-end gap-3 p-4">
              <Field label="From" htmlFor="from">
                <Input id="from" name="from" type="date" required />
              </Field>
              <Field label="To" htmlFor="to">
                <Input id="to" name="to" type="date" required />
              </Field>
              <Button type="submit" variant="secondary">
                <Download className="h-4 w-4" aria-hidden />
                Download range
              </Button>
            </form>
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title="Recent show days"
            description="Taken from the published schedule — the shows that ran, and what has been loaded against them."
          />
          {days.length === 0 ? (
            <EmptyState title="No published shows in the last two weeks">
              Show days appear here once a release has been published.
            </EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Show day</Th>
                  <Th>Shows that ran</Th>
                  <Th>Report</Th>
                  <Th>Watches</Th>
                  <Th>Boxes</Th>
                  <Th>Packed</Th>
                  <Th className="text-right">{isBoss ? "Sales" : ""}</Th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => {
                  const loaded = day.report?.status === "OK";
                  return (
                    <tr key={day.dateISO}>
                      <Td className="whitespace-nowrap font-medium">{formatDate(day.dateISO)}</Td>
                      <Td>
                        {shows(day.shows)}
                        <p className="mt-0.5 text-xs text-ink-subtle">
                          {loaded
                            ? `${day.loadedFiles.length} file${day.loadedFiles.length === 1 ? "" : "s"} loaded`
                            : `expects ${day.expected.describe}`}
                        </p>
                      </Td>
                      <Td>
                        {day.report === null ? (
                          <Badge tone="warn">Not loaded</Badge>
                        ) : day.report.status === "BLOCKED" ? (
                          <Badge tone="danger">Refused</Badge>
                        ) : day.missing ? (
                          <Badge tone="warn">Missing {day.missing}</Badge>
                        ) : (
                          <Badge tone="ok">
                            {day.report.uploadedByName
                              ? `by ${day.report.uploadedByName.split(" ")[0]}`
                              : "Loaded"}
                          </Badge>
                        )}
                      </Td>
                      <Td className="tabular">{loaded ? day.report!.watchCount : "—"}</Td>
                      <Td className="tabular">{day.boxesTotal || "—"}</Td>
                      <Td className="tabular">
                        {day.boxesTotal > 0 ? (
                          <span className={day.boxesSent === day.boxesTotal ? "font-medium text-ok-700" : undefined}>
                            {day.boxesSent} of {day.boxesTotal}
                          </span>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td className="text-right">
                        <div className="flex flex-col items-end gap-1.5">
                          {isBoss && loaded ? (
                            <a
                              href={`/api/sales/export?date=${day.dateISO}`}
                              className="text-sm font-medium text-brand-700 underline underline-offset-2"
                            >
                              Download
                            </a>
                          ) : null}
                          {day.report !== null ? (
                            <RemoveReport batchId={day.report.batchId} dateISO={day.dateISO} />
                          ) : null}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

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
import { listShowDays, missingReportDays } from "@/lib/server/shipping";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Sales report entry" };

/**
 * Where the morning's three exports come in.
 *
 * The only door data enters the system through: the day's boxes, the sales
 * records behind them and the commission figures all come from here.
 *
 * The day is not chosen — it is read out of the orders themselves, because the
 * files already know which show they belong to and a person picking from a
 * dropdown at 7am is one mis-click from putting a day's boxes on the wrong date.
 */
export default async function SalesReportsPage() {
  // The director loads the files; the sales figures behind them are the boss's.
  const user = await requireShippingDirector();
  const isBoss = user.role === "BOSS";
  const [days, missing] = await Promise.all([listShowDays(), missingReportDays()]);

  return (
    <>
      <PageHeader
        title="Sales report entry"
        description="The morning's TikTok and eBay exports, one show day at a time."
      />

      <div className="space-y-5">
        <MissingReports days={missing} />

        <UploadForm />

        {isBoss ? (
          <Card>
            <CardHeader
              title="Download the sales workbook"
              description="A single day from the table below, or a range here — a pay period, a month."
            />
            {/* A plain GET form: the browser navigates to the export and the
                file arrives. Nothing to go wrong client-side. */}
            <form
              action="/api/sales/export"
              method="get"
              className="flex flex-wrap items-end gap-3 p-4"
            >
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
            description="The last two weeks of published shows, and what has been loaded against them."
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
                  <Th>Shows</Th>
                  <Th>Report</Th>
                  <Th>Watches</Th>
                  <Th>Boxes</Th>
                  <Th>Packed</Th>
                  {isBoss ? <Th className="text-right">Sales</Th> : null}
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day.dateISO}>
                    <Td className="font-medium">{formatDate(day.dateISO)}</Td>
                    <Td className="tabular text-ink-muted">{day.liveShows || "—"}</Td>
                    <Td>
                      {day.report === null ? (
                        <Badge tone="warn">Not loaded</Badge>
                      ) : day.report.status === "BLOCKED" ? (
                        <Badge tone="danger">Refused</Badge>
                      ) : (
                        <Badge tone="ok">
                          {day.report.uploadedByName
                            ? `by ${day.report.uploadedByName.split(" ")[0]}`
                            : "Loaded"}
                        </Badge>
                      )}
                    </Td>
                    <Td className="tabular">{day.report?.status === "OK" ? day.report.watchCount : "—"}</Td>
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
                    {isBoss ? (
                      <Td className="text-right">
                        {day.report?.status === "OK" ? (
                          <a
                            href={`/api/sales/export?date=${day.dateISO}`}
                            className="text-sm font-medium text-brand-700 underline underline-offset-2"
                          >
                            Download
                          </a>
                        ) : (
                          <span className="text-sm text-ink-subtle">—</span>
                        )}
                      </Td>
                    ) : null}
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

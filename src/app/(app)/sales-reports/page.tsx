import type { Metadata } from "next";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
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
  await requireShippingDirector();
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

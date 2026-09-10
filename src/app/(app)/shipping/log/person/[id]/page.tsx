import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { formatDate, isDateISO, toDbDate } from "@/lib/domain/dates";
import { getPersonDay } from "@/lib/server/packing";
import { packingDayISO } from "@/lib/server/shipping";
import { getSettings } from "@/lib/server/settings";

export const metadata: Metadata = { title: "What they packed" };

/**
 * Everything one person sent on one day.
 *
 * The drill-down from the log: the numbers there say how much, this says
 * exactly which boxes — and each one opens onto its full scan record, which is
 * what a customer dispute eventually needs.
 */
export default async function PersonDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  await requireShippingDirector();

  const [{ id }, query] = await Promise.all([params, searchParams]);
  const fallback = await packingDayISO();
  const dateISO = query.date && isDateISO(query.date) ? query.date : fallback;

  const [day, settings] = await Promise.all([
    getPersonDay(id, toDbDate(dateISO)),
    getSettings(),
  ]);
  if (!day) notFound();

  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const short = day.boxes.filter((b) => b.status === "CLOSED_INCOMPLETE").length;

  return (
    <>
      <PageHeader
        title={day.name}
        description={`Boxes sent on the shows of ${formatDate(dateISO, "long")}.`}
        action={
          <Link
            href={`/shipping/log?date=${dateISO}`}
            className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas"
          >
            ← Back to the log
          </Link>
        }
      />

      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Boxes sent" value={day.boxes.length || "—"} sub={`On ${dateISO}`} />
          <Stat label="Watches packed" value={day.items || "—"} sub="Accepted scans" />
          <Stat
            label="Incomplete"
            value={short || "—"}
            tone={short > 0 ? "warn" : undefined}
            sub={short > 0 ? "Went out short or with extras" : "None"}
          />
        </div>

        <Card>
          <CardHeader
            title="Every box they closed"
            description="Open one to see each scan that went into it."
          />
          {day.boxes.length === 0 ? (
            <EmptyState title="Nothing sent on this day">
              Boxes appear here as they are closed.
            </EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Tracking</Th>
                  <Th>Buyer</Th>
                  <Th>Watches</Th>
                  <Th>Closed</Th>
                  <Th>How</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {day.boxes.map((b) => (
                  <tr key={b.id}>
                    <Td className="tabular text-xs">{b.tracking}</Td>
                    <Td className="text-ink-muted">{b.buyer || "—"}</Td>
                    <Td className="tabular">
                      {b.scanned}
                      {b.expected !== b.scanned ? (
                        <span className="text-ink-subtle"> of {b.expected}</span>
                      ) : null}
                    </Td>
                    <Td className="tabular text-ink-muted">{b.closedAt ? clock.format(b.closedAt) : "—"}</Td>
                    <Td>
                      {b.status === "CLOSED_INCOMPLETE" ? (
                        <Badge tone="warn">Incomplete</Badge>
                      ) : b.status === "CLOSED_UNVERIFIED" ? (
                        // Never "Complete": nobody checked this one.
                        <Badge tone="warn">Not scanned</Badge>
                      ) : b.isUnrecognised ? (
                        <Badge tone="warn">Not in any report</Badge>
                      ) : (
                        <Badge tone="ok">Complete</Badge>
                      )}
                    </Td>
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

import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Badge, Card, CardHeader, EmptyState, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { requireShippingDirector } from "@/lib/auth/guards";
import { diffDays, formatDate, todayISO } from "@/lib/domain/dates";
import { PLACE_LABEL } from "@/lib/domain/inventory";
import { LOOK_BACK_DAYS, bringStockUpToDateQuietly, getSalesView, getStartDate } from "@/lib/server/deduction";
import { picturesFor } from "@/lib/server/inventory";
import { getSettings } from "@/lib/server/settings";
import { StartDateForm, UpdateNowButton } from "./forms";

export const metadata: Metadata = { title: "Sales and stock" };

/**
 * How the day's sales come off stock, and what needs a person.
 *
 * A paid order is "sold, waiting to ship" until its box is packed and closed;
 * then it has left. This page shows the switch that starts it, everything
 * still waiting (oldest first, late ones marked), and anything the app could
 * not decide on its own.
 */
export default async function SalesStockPage() {
  const user = await requireShippingDirector();
  const today = todayISO((await getSettings()).timezone);
  const run = await bringStockUpToDateQuietly(user.id);
  const start = await getStartDate();
  const view = await getSalesView(today);
  const pictures = await picturesFor([
    ...view.waiting.map((w) => w.product.model),
    ...view.flagged.map((f) => f.product.model),
    ...(run?.unknown ?? []).map((u) => u.line.stockNumber),
  ]);

  // Packed the morning after a show; not sent by the end of that next day is late,
  // and two days late goes to Samuel (round 6).
  const lateness = (showDate: string) => diffDays(showDate, today);
  const late = view.waiting.filter((w) => lateness(w.showDate) >= 2);
  const veryLate = late.filter((w) => lateness(w.showDate) >= 3);

  return (
    <>
      <PageHeader
        title="Sales and stock"
        description="Paid orders come off stock as 'sold, waiting to ship'. When their box is packed and closed, they have left."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />

      <div className="space-y-5">
        <Card>
          <CardHeader
            title={start ? `Taking sales off from the shows of ${formatDate(start)}` : "Sales are not coming off stock yet"}
            description={
              start
                ? "Every paid order from that day on comes off by itself, after each upload and whenever these pages open. Sales before it never move stock."
                : "Turn this on once the opening count is done: pick the first show after the count. Until then, nothing sold moves stock."
            }
          />
          <div className="flex flex-wrap items-start justify-between gap-4 p-4">
            <StartDateForm current={start} />
            {start ? <UpdateNowButton /> : null}
          </div>
          {start && run === null ? (
            <div className="px-4 pb-4">
              <Alert tone="warn">Stock could not be brought up to date just now; what you see is how it last stood. Try again in a minute.</Alert>
            </div>
          ) : null}
        </Card>

        {start ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Waiting to ship" value={view.waiting.length} />
              <Stat label="Late (not sent by the end of the next day)" value={late.length} tone={late.length > 0 ? "warn" : "ok"} />
              <Stat label="Random pulls not named yet" value={run?.unnamed.length ?? "—"} tone={(run?.unnamed.length ?? 0) > 0 ? "warn" : undefined} />
              <Stat label="Not in the catalogue" value={run?.unknown.length ?? "—"} tone={(run?.unknown.length ?? 0) > 0 ? "danger" : undefined} />
            </div>

            {veryLate.length > 0 ? (
              <Alert tone="danger">
                {veryLate.length} watch(es) sold two or more days ago still have not been sent. Tell Samuel.
              </Alert>
            ) : null}

            <Card>
              <CardHeader
                title="Needs a look"
                description="What the app could not settle on its own. Each says what happened."
              />
              {view.flagged.length === 0 && (run?.unknown.length ?? 0) === 0 ? (
                <EmptyState title="Nothing to look at">Every sale came off cleanly.</EmptyState>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-16">
                        <span className="sr-only">Picture</span>
                      </Th>
                      <Th>Model</Th>
                      <Th>Sale</Th>
                      <Th>What happened</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(run?.unknown ?? []).map((u) => (
                      <tr key={u.key}>
                        <Td className="py-1.5">
                          <WatchImage url={pictures.get(u.line.stockNumber)} model={u.line.stockNumber} size={48} />
                        </Td>
                        <Td className="tabular font-medium">{u.model}</Td>
                        <Td className="text-ink-muted">
                          {u.line.show} {formatDate(u.line.showDate, "short")} · order {u.line.orderRef}
                        </Td>
                        <Td>
                          <Badge tone="danger">Not in the catalogue</Badge>{" "}
                          <span className="text-sm text-ink-muted">Not taken off. Add the model (an offer, a count, or the product details), and it comes off next time.</span>
                        </Td>
                      </tr>
                    ))}
                    {view.flagged.map((f) => (
                      <tr key={f.key}>
                        <Td className="py-1.5">
                          <WatchImage url={pictures.get(f.product.model)} model={f.product.model} size={48} />
                        </Td>
                        <Td>
                          <Link href={`/inventory/${encodeURIComponent(f.product.model)}`} className="tabular font-medium text-brand-700 underline">
                            {f.product.model}
                          </Link>
                        </Td>
                        <Td className="text-ink-muted">
                          {f.show} {formatDate(f.showDate, "short")} · order {f.orderRef}
                          {f.listing !== f.product.model ? <span className="block text-xs">sold as {f.listing}</span> : null}
                        </Td>
                        <Td className="text-sm">{f.flag}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            {(run?.unnamed.length ?? 0) > 0 ? (
              <Card>
                <CardHeader
                  title="Random pulls not named yet"
                  description="The report has no Model # for these, so nothing has come off yet. Their revenue counts. Each comes off random pulls as soon as its piece is scanned at packing — or fill in Model # and upload the report again."
                />
                <Table>
                  <thead>
                    <tr>
                      <Th>Sold as</Th>
                      <Th>Show</Th>
                      <Th>Order</Th>
                      <Th>Box</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {run!.unnamed.slice(0, 200).map((u) => (
                      <tr key={u.key}>
                        <Td>{u.line.stockNumber}</Td>
                        <Td className="text-ink-muted">
                          {u.line.show} {formatDate(u.line.showDate, "short")}
                        </Td>
                        <Td className="tabular">{u.line.orderRef}</Td>
                        <Td className="tabular text-ink-muted">{u.line.tracking || "—"}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            ) : null}

            <Card>
              <CardHeader title="Sold, waiting to ship" description="Oldest first. Each leaves stock when its box is packed and closed." />
              {view.waiting.length === 0 ? (
                <EmptyState title="Nothing waiting">Everything sold has been sent.</EmptyState>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-16">
                        <span className="sr-only">Picture</span>
                      </Th>
                      <Th>Model</Th>
                      <Th>Show</Th>
                      <Th>Order</Th>
                      <Th>Came off</Th>
                      <Th>
                        <span className="sr-only">Late</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.waiting.map((w) => (
                      <tr key={w.key}>
                        <Td className="py-1.5">
                          <WatchImage url={pictures.get(w.product.model)} model={w.product.model} size={48} />
                        </Td>
                        <Td>
                          <Link href={`/inventory/${encodeURIComponent(w.product.model)}`} className="tabular font-medium text-brand-700 underline">
                            {w.product.model}
                          </Link>
                          {w.listing !== w.product.model ? <span className="block text-xs text-ink-subtle">sold as {w.listing}</span> : null}
                        </Td>
                        <Td className="text-ink-muted">
                          {w.show} {formatDate(w.showDate, "short")}
                        </Td>
                        <Td className="tabular">
                          {w.orderRef}
                          {w.tracking ? <span className="block text-xs text-ink-subtle">box {w.tracking}</span> : null}
                        </Td>
                        <Td className="text-ink-muted">{PLACE_LABEL[w.place]}</Td>
                        <Td>
                          {lateness(w.showDate) >= 3 ? (
                            <Badge tone="danger">Two days late — tell Samuel</Badge>
                          ) : lateness(w.showDate) >= 2 ? (
                            <Badge tone="warn">Late</Badge>
                          ) : null}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <p className="text-xs text-ink-subtle">
              Reports are re-read for the last {LOOK_BACK_DAYS} days. A correction to an older report does not move stock by itself:
              put it right with a count.
            </p>
          </>
        ) : null}
      </div>
    </>
  );
}

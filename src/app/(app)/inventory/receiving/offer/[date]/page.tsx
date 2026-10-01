import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { requireShippingDirector } from "@/lib/auth/guards";
import { formatDate, isDateISO } from "@/lib/domain/dates";
import { getOffer } from "@/lib/server/receiving";

export const metadata: Metadata = { title: "Offer" };

/** One offer, line by line: what Daniel ordered, at what cost, and which models are new. */
export default async function OfferPage({ params }: { params: Promise<{ date: string }> }) {
  await requireShippingDirector();
  const { date } = await params;
  if (!isDateISO(date)) notFound();
  const o = await getOffer(date);
  if (!o) notFound();

  const pieces = o.lines.reduce((n, l) => n + l.qty, 0);
  const value = o.lines.reduce((n, l) => n + l.qty * l.costCents, 0);
  const waiting = o.lines.filter((l) => !l.product.active).length;
  const needDetails = o.lines.filter((l) => l.product.needsDetails).length;

  return (
    <>
      <PageHeader
        title={`Offer of ${formatDate(o.date)}`}
        description={`${o.fileName}${o.by ? ` · loaded by ${o.by.name}` : ""}`}
        action={<LinkButton href="/inventory/receiving">Back to receiving</LinkButton>}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Models" value={o.lines.length} />
        <Stat label="Pieces ordered" value={pieces.toLocaleString("en-US")} />
        <Stat label="At cost" value={`$${(value / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
        <Stat label="Need their details" value={needDetails} tone={needDetails > 0 ? "warn" : "ok"} />
      </div>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th className="w-16">
                <span className="sr-only">Picture</span>
              </Th>
              <Th>Model</Th>
              <Th className="text-right">Ordered</Th>
              <Th className="text-right">Cost</Th>
              <Th>In the app</Th>
            </tr>
          </thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.product.model}>
                <Td className="py-1.5">
                  <WatchImage url={l.picture} model={l.product.model} size={48} />
                </Td>
                <Td>
                  <Link href={`/inventory/${encodeURIComponent(l.product.model)}`} className="tabular font-medium text-brand-700 underline">
                    {l.product.model}
                  </Link>
                  {l.product.description ? <span className="block max-w-sm truncate text-xs text-ink-subtle">{l.product.description}</span> : null}
                </Td>
                <Td className="tabular text-right">{l.qty}</Td>
                <Td className="tabular text-right">${(l.costCents / 100).toFixed(2)}</Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {!l.product.active ? <Badge tone="brand">Not arrived yet</Badge> : null}
                    {l.product.needsDetails ? <Badge tone="warn">Needs its details</Badge> : null}
                    {l.product.active && !l.product.needsDetails ? <Badge tone="ok">In the catalogue</Badge> : null}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {waiting > 0 ? (
        <p className="mt-3 text-xs text-ink-subtle">
          {waiting} model(s) are not active yet: they become active when a shipment of them is counted in.
        </p>
      ) : null}
    </>
  );
}

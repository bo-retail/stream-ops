import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Card, CardHeader, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { PLACES, PLACE_LABEL } from "@/lib/domain/inventory";
import { getModel } from "@/lib/server/inventory";

export const metadata: Metadata = { title: "Inventory" };

const money = (cents: number | null) => (cents === null ? "—" : `$${(cents / 100).toFixed(2)}`);
const when = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

/** One model: what it is, where its pieces are, and every change. */
export default async function ModelPage({ params }: { params: Promise<{ model: string }> }) {
  await requireShippingDirector();
  const { model } = await params;
  const found = await getModel(decodeURIComponent(model));
  if (!found) notFound();
  const { product: p, balances } = found;
  const total = PLACES.reduce((n, place) => n + balances[place], 0);

  return (
    <>
      <PageHeader
        title={p.model}
        description={p.description || "No description yet."}
        action={
          <div className="flex gap-2">
            <LinkButton href={`/inventory/count?q=${encodeURIComponent(p.model)}`} variant="primary">
              Count it
            </LinkButton>
            <LinkButton href="/inventory">Back</LinkButton>
          </div>
        }
      />
      {p.needsDetails ? (
        <p className="mb-4">
          <Badge tone="warn">Added at a count — needs its details from the master file</Badge>
        </p>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {PLACES.map((place) => (
          <Stat key={place} label={PLACE_LABEL[place]} value={balances[place]} tone={balances[place] < 0 ? "danger" : undefined} />
        ))}
        <Stat label="Total" value={total} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Details" />
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 p-4 text-sm">
            {[
              ["Brand", p.brand],
              ["Collection", p.collection],
              ["Gender", p.gender],
              ["Cost", money(p.costCents)],
              ["Target price", money(p.tpCents)],
              ["MSRP", money(p.msrpCents)],
              ["TikTok box", p.weightLb !== null ? `${p.weightLb} lb · ${p.lengthIn}×${p.widthIn}×${p.heightIn} in` : ""],
              ["eBay profile", p.ebayShippingProfile],
              ["UPC", p.upc],
            ].map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink-muted">{label}</dt>
                <dd className="text-ink">{value || "—"}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="History" description="Every change, newest first. Nothing here is ever edited or removed." />
          {p.moves.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-muted">Not counted yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>What</Th>
                  <Th>Place</Th>
                  <Th className="text-right">Change</Th>
                  <Th>By</Th>
                </tr>
              </thead>
              <tbody>
                {p.moves.map((m) => (
                  <tr key={m.id}>
                    <Td className="whitespace-nowrap text-ink-muted">{when.format(m.at)}</Td>
                    <Td>
                      Counted {m.countedQty}
                      {m.note ? <span className="block text-xs text-ink-subtle">{m.note}</span> : null}
                    </Td>
                    <Td>{PLACE_LABEL[m.place]}</Td>
                    <Td className="tabular text-right">
                      {m.qty === 0 ? <span className="text-ink-subtle">matched</span> : m.qty > 0 ? `+${m.qty}` : m.qty}
                    </Td>
                    <Td className="text-ink-muted">{m.by?.name ?? "—"}</Td>
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

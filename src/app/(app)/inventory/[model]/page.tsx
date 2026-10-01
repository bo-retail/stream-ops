import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Card, CardHeader, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { pictureFor } from "@/lib/domain/watch-images";
import { requireShippingDirector } from "@/lib/auth/guards";
import { PLACES, PLACE_LABEL } from "@/lib/domain/inventory";
import { getModel } from "@/lib/server/inventory";
import { DetailsEditor } from "./details-editor";
import { PictureEditor } from "./picture-editor";

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
  // Next has already decoded it; decoding again would break a model with a "%".
  const found = await getModel(model);
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
      {p.needsDetails || !p.active ? (
        <p className="mb-4 flex flex-wrap gap-2">
          {!p.active ? <Badge tone="brand">Ordered — not arrived yet. It becomes active when a shipment of it is counted in.</Badge> : null}
          {p.needsDetails ? <Badge tone="warn">Needs its details — fill them in below</Badge> : null}
        </p>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {PLACES.map((place) => (
          <Stat key={place} label={PLACE_LABEL[place]} value={balances[place]} tone={balances[place] < 0 ? "danger" : undefined} />
        ))}
        <Stat label="Total" value={total} />
        {balances.WAITING !== 0 ? <Stat label="Sold, waiting to ship" value={balances.WAITING} /> : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Details" />
          <div className="flex justify-center border-b border-line p-4">
            <WatchImage url={pictureFor(p.model, p.imageUrl, p.photo?.updatedAt)} model={p.model} size={256} priority />
          </div>
          <PictureEditor key={p.imageUrl} model={p.model} hasPhoto={p.photo !== null} imageUrl={p.imageUrl} />
          <DetailsEditor
            key={p.updatedAt.getTime()}
            model={p.model}
            details={{
              brand: p.brand,
              collection: p.collection,
              gender: p.gender,
              description: p.description,
              costCents: p.costCents,
              tpCents: p.tpCents,
              msrpCents: p.msrpCents,
              weightLb: p.weightLb,
              lengthIn: p.lengthIn,
              widthIn: p.widthIn,
              heightIn: p.heightIn,
              ebayShippingProfile: p.ebayShippingProfile,
              upc: p.upc,
            }}
          />
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="History" description="Every change, newest first. Nothing here is ever edited or removed." />
          {p.moves.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-muted">Not counted or received yet.</p>
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
                      {m.kind === "RECEIVED" ? (
                        <>
                          Received{m.unitCostCents !== null ? ` at ${money(m.unitCostCents)}` : ""}
                        </>
                      ) : m.kind === "SOLD" ? (
                        <>{(m.place === "WAITING") === (m.qty > 0) ? "Sold" : "Put back (the report no longer has it)"}</>
                      ) : m.kind === "SENT" ? (
                        <>{m.qty < 0 ? "Sent" : "Box reopened"}</>
                      ) : m.kind === "MOVE" ? (
                        <>Moved{m.reason ? ` (${m.reason.toLowerCase()})` : ""}</>
                      ) : m.kind === "ADJUST" ? (
                        <>{m.reason || "Adjusted"}</>
                      ) : m.kind === "RETURN" ? (
                        <>{m.reason || "Return"}</>
                      ) : (
                        <>Counted {m.countedQty}</>
                      )}
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

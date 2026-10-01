import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { Badge, Card, CardHeader, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { requireShippingDirector } from "@/lib/auth/guards";
import { getShipment } from "@/lib/server/receiving";
import { SettleButton, UploadShipmentCount } from "../forms";
import { CountForm } from "./count-form";

export const metadata: Metadata = { title: "Shipment" };

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const KIND_TONE = { short: "warn", over: "warn", "not on the list": "warn", damaged: "danger" } as const;

/** One shipment: count it in, and see what differs from Invicta's list. */
export default async function ShipmentPage({ params }: { params: Promise<{ sop: string }> }) {
  await requireShippingDirector();
  const { sop } = await params;
  const s = await getShipment(sop);
  if (!s) notFound();

  const listed = s.lines.reduce((n, l) => n + l.listedQty, 0);
  const counted = s.lines.reduce((n, l) => n + (l.countedQty ?? 0), 0);
  const value = s.lines.reduce((n, l) => n + l.listedQty * (l.unitCostCents ?? 0), 0);
  const notCounted = s.lines.filter((l) => l.countedQty === null && l.listedQty > 0).length;
  const withDiff = s.lines.filter((l) => l.differences.length > 0);

  return (
    <>
      <PageHeader
        title={`Shipment ${s.sop}`}
        description={`${s.po ? `${s.po} · ` : ""}list loaded ${when.format(s.uploadedAt)}${s.by ? ` by ${s.by.name}` : ""}${s.countedAt ? ` · last counted ${when.format(s.countedAt)}` : ""}`}
        action={<LinkButton href="/inventory/receiving">Back to receiving</LinkButton>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="On the list" value={listed.toLocaleString("en-US")} />
        <Stat label="Counted" value={s.countedAt ? counted.toLocaleString("en-US") : "—"} />
        <Stat label="Models not counted yet" value={notCounted} tone={notCounted > 0 ? "warn" : "ok"} />
        <Stat label="At list cost" value={`$${(value / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
      </div>

      <div className="space-y-5">
        {withDiff.length > 0 ? (
          <Card>
            <CardHeader title="Differences with Invicta" description="Gladys's count is the truth. Each stays open until it is settled." />
            <Table>
              <thead>
                <tr>
                  <Th className="w-16">
                    <span className="sr-only">Picture</span>
                  </Th>
                  <Th>Model</Th>
                  <Th className="text-right">On the list</Th>
                  <Th className="text-right">Counted</Th>
                  <Th>What</Th>
                  <Th>Settled</Th>
                </tr>
              </thead>
              <tbody>
                {withDiff.map((l) => (
                  <tr key={l.id}>
                    <Td className="py-1.5">
                      <WatchImage url={l.picture} model={l.product.model} size={48} />
                    </Td>
                    <Td className="tabular font-medium">{l.product.model}</Td>
                    <Td className="tabular text-right">{l.listedQty}</Td>
                    <Td className="tabular text-right">{l.countedQty}</Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {l.differences.map((k) => (
                          <Badge key={k.kind} tone={KIND_TONE[k.kind]}>
                            {k.qty} {k.kind}
                          </Badge>
                        ))}
                      </span>
                    </Td>
                    <Td>
                      {l.settledAt ? (
                        <span className="text-sm text-ok-700">
                          Settled{l.settledBy ? ` by ${l.settledBy.name}` : ""}
                          {l.settledNote ? <span className="block text-xs text-ink-muted">{l.settledNote}</span> : null}
                        </span>
                      ) : (
                        <SettleButton lineId={l.id} />
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : null}

        <CountForm
          key={s.countedAt?.getTime() ?? 0}
          sop={s.sop}
          lines={s.lines.map((l) => ({
            model: l.product.model,
            description: l.product.description,
            picture: l.picture,
            listed: l.listedQty,
            priceCents: l.unitCostCents,
            offerCents: l.offer?.costCents ?? null,
            counted: l.countedQty,
            damaged: l.damagedQty,
          }))}
        />

        <Card>
          <CardHeader title="Or count it on a sheet" description="The same count, in Excel: download it, fill in Counted and Damaged, upload it." />
          <div className="space-y-4 p-4">
            <a
              href={`/api/inventory/shipment-sheet/${encodeURIComponent(s.sop)}`}
              className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-ink hover:bg-canvas"
            >
              <Download className="h-4 w-4" aria-hidden /> Download {s.sop}&apos;s count sheet
            </a>
            <UploadShipmentCount sop={s.sop} />
          </div>
        </Card>

        <p className="text-xs text-ink-subtle">
          New models on this shipment need their details (description, target price, TikTok size, eBay profile, picture) on their{" "}
          <Link href="/inventory" className="underline">
            model pages
          </Link>{" "}
          or on the product details sheet in Templates &amp; uploads.
        </p>
      </div>
    </>
  );
}

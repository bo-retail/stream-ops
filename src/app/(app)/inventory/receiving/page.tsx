import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { requireShippingDirector } from "@/lib/auth/guards";
import { formatDate } from "@/lib/domain/dates";
import { STILL_TO_COME_DAYS } from "@/lib/domain/receiving";
import { getReceiving } from "@/lib/server/receiving";
import { SettleButton, UploadOffer, UploadShippingList } from "./forms";

export const metadata: Metadata = { title: "Receiving" };

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

const KIND_TONE = { short: "warn", over: "warn", "not on the list": "warn", damaged: "danger" } as const;

/**
 * Receiving, in Daniel's order: the offer creates the models, the shipping
 * list says what to expect, Gladys's count puts it in stock. Then what is
 * different from Invicta's list, and what was ordered and has not come yet.
 */
export default async function ReceivingPage() {
  await requireShippingDirector();
  const r = await getReceiving();

  return (
    <>
      <PageHeader
        title="Receiving"
        description="Offer → shipping list → Gladys's count. Only the count puts watches in stock."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />

      <div className="space-y-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="1. The offer"
              description="When Daniel orders. Models he has never ordered before are created, not active until they arrive. The same date again replaces that offer."
            />
            <div className="p-4">
              <UploadOffer today={r.today} />
            </div>
          </Card>
          <Card>
            <CardHeader
              title="2. The shipping list"
              description="When the boxes arrive. Says what Invicta sent and at what price. Nothing goes into stock until it is counted."
            />
            <div className="p-4">
              <UploadShippingList />
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader title="3. Shipments" description="Open one to count it. Gladys's count is the truth, not Invicta's list." />
          {r.shipments.length === 0 ? (
            <EmptyState title="No shipments yet">Upload a shipping list above.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>SOP</Th>
                  <Th>Arrived</Th>
                  <Th className="text-right">Models</Th>
                  <Th className="text-right">On the list</Th>
                  <Th className="text-right">Counted</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {r.shipments.map((s) => (
                  <tr key={s.id}>
                    <Td>
                      <Link href={`/inventory/receiving/${encodeURIComponent(s.sop)}`} className="tabular font-medium text-brand-700 underline">
                        {s.sop}
                      </Link>
                      {s.po ? <span className="block text-xs text-ink-subtle">{s.po}</span> : null}
                    </Td>
                    <Td className="text-ink-muted">{when.format(s.uploadedAt)}</Td>
                    <Td className="tabular text-right">{s.models}</Td>
                    <Td className="tabular text-right">{s.listed.toLocaleString("en-US")}</Td>
                    <Td className="tabular text-right">{s.counted === null ? "—" : s.counted.toLocaleString("en-US")}</Td>
                    <Td>
                      {s.countedAt === null ? (
                        <Badge tone="brand">To count</Badge>
                      ) : s.uncounted > 0 ? (
                        <Badge tone="brand">
                          Being counted ({s.models - s.uncounted} of {s.models})
                        </Badge>
                      ) : s.openDifferences > 0 ? (
                        <Badge tone="warn">{s.openDifferences} difference(s) open</Badge>
                      ) : (
                        <Badge tone="ok">Counted</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Differences with Invicta"
            description="Short: they ship the balance. Over: they adjust the invoice. Damaged: a credit or a replacement. Each stays here until it is settled."
          />
          {r.differences.length === 0 ? (
            <EmptyState title="Nothing open">Every counted shipment matches its list, or has been settled.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-16">
                    <span className="sr-only">Picture</span>
                  </Th>
                  <Th>Model</Th>
                  <Th>Shipment</Th>
                  <Th className="text-right">On the list</Th>
                  <Th className="text-right">Counted</Th>
                  <Th>What</Th>
                  <Th>
                    <span className="sr-only">Settle</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {r.differences.map((d) => (
                  <tr key={d.lineId}>
                    <Td className="py-1.5">
                      <WatchImage url={d.picture} model={d.model} size={48} />
                    </Td>
                    <Td>
                      <Link href={`/inventory/${encodeURIComponent(d.model)}`} className="tabular font-medium text-brand-700 underline">
                        {d.model}
                      </Link>
                    </Td>
                    <Td>
                      <Link href={`/inventory/receiving/${encodeURIComponent(d.sop)}`} className="tabular underline">
                        {d.sop}
                      </Link>
                    </Td>
                    <Td className="tabular text-right">{d.listed}</Td>
                    <Td className="tabular text-right">{d.counted}</Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {d.kinds.map((k) => (
                          <Badge key={k.kind} tone={KIND_TONE[k.kind]}>
                            {k.qty} {k.kind}
                          </Badge>
                        ))}
                      </span>
                    </Td>
                    <Td>
                      <SettleButton lineId={d.lineId} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Still to come"
            description={`Ordered on an offer, not yet on any shipping list. Drops off after ${STILL_TO_COME_DAYS} days; it stays in the offer's history.`}
          />
          {r.toCome.length === 0 ? (
            <EmptyState title="Nothing waiting">Everything ordered in the last {STILL_TO_COME_DAYS} days has shipped.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-16">
                    <span className="sr-only">Picture</span>
                  </Th>
                  <Th>Model</Th>
                  <Th>Offer</Th>
                  <Th className="text-right">Ordered</Th>
                  <Th className="text-right">Shipped</Th>
                  <Th className="text-right">Still to come</Th>
                </tr>
              </thead>
              <tbody>
                {r.toCome.map((t) => (
                  <tr key={`${t.offerDate}-${t.model}`}>
                    <Td className="py-1.5">
                      <WatchImage url={t.picture} model={t.model} size={48} />
                    </Td>
                    <Td>
                      <Link href={`/inventory/${encodeURIComponent(t.model)}`} className="tabular font-medium text-brand-700 underline">
                        {t.model}
                      </Link>
                      {t.description ? <span className="block max-w-xs truncate text-xs text-ink-subtle">{t.description}</span> : null}
                    </Td>
                    <Td>
                      <Link href={`/inventory/receiving/offer/${t.offerDate}`} className="underline">
                        {formatDate(t.offerDate)}
                      </Link>
                    </Td>
                    <Td className="tabular text-right">{t.ordered}</Td>
                    <Td className="tabular text-right">{t.shipped}</Td>
                    <Td className="tabular text-right font-semibold">{t.toCome}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Offers" description="Newest first." />
          {r.offers.length === 0 ? (
            <EmptyState title="No offers yet">Upload Daniel&apos;s offer above.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>File</Th>
                  <Th className="text-right">Models</Th>
                  <Th className="text-right">Pieces ordered</Th>
                </tr>
              </thead>
              <tbody>
                {r.offers.map((o) => (
                  <tr key={o.id}>
                    <Td>
                      <Link href={`/inventory/receiving/offer/${o.date}`} className="font-medium text-brand-700 underline">
                        {formatDate(o.date)}
                      </Link>
                    </Td>
                    <Td className="max-w-xs truncate text-ink-muted">{o.fileName}</Td>
                    <Td className="tabular text-right">{o.models}</Td>
                    <Td className="tabular text-right">{o.pieces.toLocaleString("en-US")}</Td>
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

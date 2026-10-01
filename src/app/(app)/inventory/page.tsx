import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, EmptyState, Input, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { requireShippingDirector } from "@/lib/auth/guards";
import { PLACES, PLACE_LABEL } from "@/lib/domain/inventory";
import { bringStockUpToDateQuietly } from "@/lib/server/deduction";
import { listStock } from "@/lib/server/inventory";

export const metadata: Metadata = { title: "Inventory" };

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/**
 * What is in stock, model by model.
 *
 * One table: every model, what is in each place, and a link to its history.
 * The search narrows it; nothing else to learn.
 */
export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireShippingDirector();
  const { q = "" } = await searchParams;
  // Today's sales and packing, taken off before stock is shown.
  const run = await bringStockUpToDateQuietly(user.id, { ifChanged: true });
  const rows = await listStock(q);
  const all = q ? null : rows;

  const pieces = rows.reduce((n, r) => n + r.total, 0);
  const value = rows.reduce((n, r) => n + r.total * (r.costCents ?? 0), 0);
  const notCounted = rows.filter((r) => r.lastCountedAt === null).length;
  const flagged = rows.filter((r) => r.needsDetails).length;

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Every model and how many are in each place."
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/inventory/count" variant="primary">
              Count
            </LinkButton>
            <LinkButton href="/inventory/sales">Sales</LinkButton>
            <LinkButton href="/inventory/receiving">Receiving</LinkButton>
            <LinkButton href="/inventory/templates">Templates &amp; uploads</LinkButton>
          </div>
        }
      />

      {run === null ? (
        <p className="mb-4 rounded-lg border border-warn-200 bg-warn-50 px-4 py-3 text-sm text-warn-700">
          Stock could not be brought up to date with the latest sales just now; this is how it last stood. See{" "}
          <Link href="/inventory/sales" className="underline">Sales</Link>.
        </p>
      ) : null}

      {all && all.length > 0 ? (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Models" value={all.length.toLocaleString("en-US")} />
          <Stat label="Pieces" value={pieces.toLocaleString("en-US")} />
          <Stat label="At cost" value={money(value)} />
          <Stat
            label="Not counted yet"
            value={notCounted.toLocaleString("en-US")}
            tone={notCounted > 0 ? "warn" : "ok"}
          />
        </div>
      ) : null}

      <Card>
        <form className="flex flex-wrap items-center gap-2 border-b border-line p-3" action="/inventory">
          <Input
            name="q"
            defaultValue={q}
            placeholder="Search a model, description or collection"
            className="max-w-sm"
            aria-label="Search"
          />
          {q ? (
            <Link href="/inventory" className="text-sm text-ink-muted underline">
              Clear
            </Link>
          ) : null}
          {flagged > 0 ? <Badge tone="warn">{flagged} need their details</Badge> : null}
        </form>

        {rows.length === 0 ? (
          <EmptyState title={q ? "No model matches that." : "The catalogue is empty."}>
            {q ? null : (
              <>
                Load Invicta&apos;s master file on{" "}
                <Link href="/inventory/templates" className="underline">
                  Templates &amp; uploads
                </Link>{" "}
                first.
              </>
            )}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-16">
                  <span className="sr-only">Picture</span>
                </Th>
                <Th>Model</Th>
                <Th>Description</Th>
                {PLACES.map((p) => (
                  <Th key={p} className="text-right">
                    {PLACE_LABEL[p]}
                  </Th>
                ))}
                <Th className="text-right">Total</Th>
                <Th className="text-right">Sold, waiting to ship</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model}>
                  <Td className="py-1.5">
                    <Link href={`/inventory/${encodeURIComponent(r.model)}`} tabIndex={-1}>
                      <WatchImage url={r.picture} model={r.model} size={48} />
                    </Link>
                  </Td>
                  <Td>
                    <Link href={`/inventory/${encodeURIComponent(r.model)}`} className="tabular font-medium text-brand-700 underline">
                      {r.model}
                    </Link>
                    {!r.active ? (
                      <span className="block text-xs text-brand-700">Ordered, not arrived yet</span>
                    ) : null}
                    {r.needsDetails ? (
                      <span className="block text-xs text-warn-700">Needs its details</span>
                    ) : r.active && r.lastCountedAt === null ? (
                      <span className="block text-xs text-ink-subtle">Not counted yet</span>
                    ) : null}
                  </Td>
                  <Td className="max-w-xs truncate text-ink-muted">{r.description || "—"}</Td>
                  {PLACES.map((p) => (
                    <Td key={p} className={`tabular text-right ${r.balances[p] < 0 ? "font-semibold text-danger-600" : ""}`}>
                      {r.balances[p] === 0 ? <span className="text-ink-subtle">0</span> : r.balances[p]}
                    </Td>
                  ))}
                  <Td className="tabular text-right font-semibold">{r.total}</Td>
                  <Td className="tabular text-right text-ink-muted">{r.balances.WAITING === 0 ? "" : r.balances.WAITING}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

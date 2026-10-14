import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, Input, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { requireShippingDirector } from "@/lib/auth/guards";
import { formatDate } from "@/lib/domain/dates";
import { COUNTED_LABEL, COUNTED_PLACES } from "@/lib/domain/inventory";
import { bringStockUpToDateQuietly, getStartDate } from "@/lib/server/deduction";
import { listStock } from "@/lib/server/inventory";

export const metadata: Metadata = { title: "Inventory" };

/**
 * What is in stock, model by model — kept simple (Samuel, 10/14).
 *
 * Each model's Sellable, TT sample, eBay sample and Random pulls. A starting
 * count sets them; every sales report uploaded since subtracts. Nothing else.
 */
export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireShippingDirector();
  const { q = "" } = await searchParams;
  // Today's sales taken off before stock is shown — in full, so what could
  // not be taken off is known and shown below.
  const run = await bringStockUpToDateQuietly(user.id);
  const [all, from] = await Promise.all([listStock(q), getStartDate()]);

  // Models with stock, or below zero (sold more than was counted), only.
  const total = (r: (typeof all)[number]) => COUNTED_PLACES.reduce((n, p) => n + r.balances[p], 0);
  const rows = all.filter((r) => COUNTED_PLACES.some((p) => r.balances[p] !== 0));
  const pieces = rows.reduce((n, r) => n + total(r), 0);

  return (
    <>
      <PageHeader
        title="Inventory"
        description={
          from
            ? `From the starting count. Sales from ${formatDate(from)} on come off automatically when the sales report is uploaded.`
            : "Nothing counted yet. Do the starting count to begin."
        }
        action={
          <LinkButton href="/inventory/start" variant="primary">
            Starting count
          </LinkButton>
        }
      />

      {run === null ? (
        <p className="mb-4 rounded-lg border border-warn-200 bg-warn-50 px-4 py-3 text-sm text-warn-700">
          The latest sales could not be taken off just now; this is how stock last stood. Reload in a minute.
        </p>
      ) : null}

      {run && (run.unknown.length > 0 || run.unnamed.length > 0) ? (
        <div className="mb-4 rounded-lg border border-warn-200 bg-warn-50 px-4 py-3 text-sm text-warn-700">
          <p className="font-medium">Sold, but not taken off — nothing to take them off from:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {run.unknown.length > 0 ? (
              <li>
                {run.unknown.length} sale(s) of a model that is not in inventory:{" "}
                {[...new Set(run.unknown.map((w) => w.line.stockNumber))].slice(0, 12).join(", ")}
                {run.unknown.length > 12 ? "…" : ""}. Add them on the next count if they are ours.
              </li>
            ) : null}
            {run.unnamed.length > 0 ? (
              <li>
                {run.unnamed.length} random pull(s) with no model number yet — they come off once the report names the
                watch, or it is scanned when packed.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {!q && rows.length > 0 ? (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Models" value={rows.length.toLocaleString("en-US")} />
          <Stat label="Pieces" value={pieces.toLocaleString("en-US")} />
        </div>
      ) : null}

      <Card>
        <form className="flex flex-wrap items-center gap-2 border-b border-line p-3" action="/inventory">
          <Input name="q" defaultValue={q} placeholder="Search a model or description" className="max-w-sm" aria-label="Search" />
          {q ? (
            <Link href="/inventory" className="text-sm text-ink-muted underline">
              Clear
            </Link>
          ) : null}
        </form>

        {rows.length === 0 ? (
          <EmptyState title={q ? "No model matches that." : "Nothing in stock yet."}>
            {q ? null : (
              <>
                Do the{" "}
                <Link href="/inventory/start" className="underline">
                  starting count
                </Link>{" "}
                to begin.
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
                {COUNTED_PLACES.map((p) => (
                  <Th key={p} className="text-right">
                    {COUNTED_LABEL[p]}
                  </Th>
                ))}
                <Th className="text-right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model}>
                  <Td className="py-1.5">
                    <WatchImage url={r.picture} model={r.model} size={48} />
                  </Td>
                  <Td className="tabular font-medium">{r.model}</Td>
                  <Td className="max-w-xs truncate text-ink-muted">{r.description || "—"}</Td>
                  {COUNTED_PLACES.map((p) => (
                    <Td key={p} className={`tabular text-right ${r.balances[p] < 0 ? "font-semibold text-danger-600" : ""}`}>
                      {r.balances[p] === 0 ? <span className="text-ink-subtle">0</span> : r.balances[p]}
                    </Td>
                  ))}
                  <Td className="tabular text-right font-semibold">{total(r)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {rows.some((r) => COUNTED_PLACES.some((p) => r.balances[p] < 0)) ? (
        <p className="mt-3 text-xs text-ink-muted">
          A number in red is below zero: more sold than was counted. The next count puts it right.
        </p>
      ) : null}
    </>
  );
}

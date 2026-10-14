import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, Input, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { requireShippingDirector } from "@/lib/auth/guards";
import { formatDate, todayISO } from "@/lib/domain/dates";
import { rangeOf, soldByModel } from "@/lib/server/inventory-export";
import { getSettings } from "@/lib/server/settings";
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
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; from?: string; to?: string }>;
}) {
  const user = await requireShippingDirector();
  const { q = "", from: fromParam, to: toParam } = await searchParams;
  const today = todayISO((await getSettings()).timezone);
  // Today's sales taken off before stock is shown — in full, so what could
  // not be taken off is known and shown below.
  const run = await bringStockUpToDateQuietly(user.id);
  const [all, from] = await Promise.all([listStock(q), getStartDate()]);
  // How much came off over a stretch of show days: the start day to today, or whatever is picked.
  const range = rangeOf(from, today, fromParam, toParam);
  const soldIn = await soldByModel(range.from, range.to, today);
  const rangeQuery = `from=${range.from}&to=${range.to}`;

  // Models with stock, or below zero (sold more than was counted), only.
  const total = (r: (typeof all)[number]) => COUNTED_PLACES.reduce((n, p) => n + r.balances[p], 0);
  const rows = all.filter((r) => COUNTED_PLACES.some((p) => r.balances[p] !== 0) || soldIn.has(r.model));
  const pieces = rows.reduce((n, r) => n + total(r), 0);
  // Over what is shown, so a search narrows all three numbers alike.
  const withStock = rows.filter((r) => COUNTED_PLACES.some((p) => r.balances[p] !== 0)).length;
  const soldTotal = rows.reduce((n, r) => n + (soldIn.get(r.model) ?? 0), 0);

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
          <div className="flex flex-wrap gap-2">
            {/* A file download, not a page: a plain link. */}
            <a
              href={`/api/inventory/export?${rangeQuery}`}
              className="inline-flex items-center rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas"
            >
              Download Excel
            </a>
            <LinkButton href="/inventory/start" variant="primary">
              Starting count
            </LinkButton>
          </div>
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
          <Stat label="Models in stock" value={withStock.toLocaleString("en-US")} />
          <Stat label="Pieces" value={pieces.toLocaleString("en-US")} />
          <Stat
            label={range.from === range.to ? `Sold ${formatDate(range.from, "short")}` : `Sold ${formatDate(range.from, "short")} – ${formatDate(range.to, "short")}`}
            value={soldTotal.toLocaleString("en-US")}
          />
        </div>
      ) : null}

      <Card>
        <form className="flex flex-wrap items-end gap-2 border-b border-line p-3" action="/inventory">
          <Input name="q" defaultValue={q} placeholder="Search a model or description" className="max-w-xs" aria-label="Search" />
          <label className="text-xs text-ink-muted">
            Sold from
            <Input name="from" type="date" defaultValue={range.from} min={from ?? undefined} max={today} className="w-40" />
          </label>
          <label className="text-xs text-ink-muted">
            to
            <Input name="to" type="date" defaultValue={range.to} min={from ?? undefined} max={today} className="w-40" />
          </label>
          <button type="submit" className="rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-canvas">
            Show
          </button>
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
          // Fixed widths, so the table fits the screen: the description gives way
          // (shortened, the whole of it on hover), never the numbers.
          <Table className="table-fixed">
            <thead>
              <tr>
                <Th className="w-14 px-2">
                  <span className="sr-only">Picture</span>
                </Th>
                <Th className="w-28 px-2">Model</Th>
                <Th className="px-2">Description</Th>
                {COUNTED_PLACES.map((p) => (
                  <Th key={p} className="w-20 whitespace-normal px-2 text-right leading-tight">
                    {COUNTED_LABEL[p]}
                  </Th>
                ))}
                <Th className="w-16 px-2 text-right">Total</Th>
                <Th className="w-16 whitespace-normal px-2 text-right leading-tight" title={`Taken off ${range.from} to ${range.to}`}>
                  Sold
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model}>
                  <Td className="px-2 py-1">
                    <WatchImage url={r.picture} model={r.model} size={36} />
                  </Td>
                  <Td className="truncate px-2 tabular font-medium" title={r.model}>{r.model}</Td>
                  <Td className="truncate px-2 text-ink-muted" title={r.description}>{r.description || "—"}</Td>
                  {COUNTED_PLACES.map((p) => (
                    <Td key={p} className={`px-2 tabular text-right ${r.balances[p] < 0 ? "font-semibold text-danger-600" : ""}`}>
                      {r.balances[p] === 0 ? <span className="text-ink-subtle">0</span> : r.balances[p]}
                    </Td>
                  ))}
                  <Td className="px-2 tabular text-right font-semibold">{total(r)}</Td>
                  <Td className="px-2 tabular text-right text-ink-muted">{soldIn.get(r.model) ?? ""}</Td>
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

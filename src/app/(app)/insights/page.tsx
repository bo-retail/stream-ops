import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { DailyBars, SERIES, SplitBar } from "@/components/charts";
import { requireBoss } from "@/lib/auth/guards";
import { formatDate, isDateISO } from "@/lib/domain/dates";
import { formatChange, formatMoney, formatMoneyShort } from "@/lib/domain/insights";
import type { Change } from "@/lib/domain/insights";
import { getSalesInsights, rangePresets, resolveRange } from "@/lib/server/insights";

export const metadata: Metadata = { title: "Sales insights" };

/**
 * What the sales say.
 *
 * Ordered by what changes a decision, top to bottom, and nothing on it is
 * decoration:
 *
 *   1  Revenue, volume, average price, buyers — with the movement on each.
 *      Revenue alone can rise on price while volume falls, so they sit together.
 *   2  The shape of it over time. One chart, not four.
 *   3  Where it sells — marketplace and day-against-night. This is the one that
 *      moves people around a rota.
 *   4  What sells — the best sellers, and which of them keep selling.
 *   5  The daily detail, for anyone checking a figure back to its source.
 *
 * Boss only. The shipping director loads the files and packs against them, but
 * what the business took is not her screen.
 */

function Delta({ change: c, invert = false }: { change: Change; invert?: boolean }) {
  const text = formatChange(c);
  const good = invert ? c.direction === "down" : c.direction === "up";
  const bad = invert ? c.direction === "up" : c.direction === "down";

  return (
    <span
      className={
        good
          ? "text-ok-700"
          : bad
            ? "text-danger-600"
            : "text-ink-subtle"
      }
    >
      {c.direction === "up" ? "▲ " : c.direction === "down" ? "▼ " : ""}
      {text}
    </span>
  );
}

function Headline({
  label,
  value,
  change: c,
  hint,
}: {
  label: string;
  value: string;
  change: Change;
  hint: string;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</p>
      <p className="tabular mt-1 text-3xl font-semibold text-ink">{value}</p>
      <p className="tabular mt-1 text-sm font-medium">
        <Delta change={c} /> <span className="font-normal text-ink-subtle">{hint}</span>
      </p>
    </div>
  );
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requireBoss();

  const query = await searchParams;
  const presets = await rangePresets();
  const range = resolveRange(
    presets,
    query.period,
    query.from && isDateISO(query.from) ? query.from : undefined,
    query.to && isDateISO(query.to) ? query.to : undefined,
  );

  const insights = await getSalesInsights(range.from, range.to);
  const { totals, changes } = insights;

  const colourFor = (key: string) =>
    key.toLowerCase().startsWith("tiktok")
      ? SERIES.tiktok
      : key.toLowerCase().startsWith("ebay")
        ? SERIES.ebay
        : key === "Day"
          ? SERIES.brand
          : SERIES.tiktok;

  return (
    <>
      <PageHeader
        title="Sales insights"
        description={`${formatDate(range.from)} to ${formatDate(range.to)} · compared with the ${insights.previous.from} to ${insights.previous.to} before it`}
        action={
          <a
            href={`/api/sales/export?from=${range.from}&to=${range.to}`}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Download className="h-4 w-4" aria-hidden />
            Download
          </a>
        }
      />

      {/* ------------------------------------------------------- the periods */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <Link
            key={p.key}
            href={`/insights?period=${p.key}`}
            className={
              p.key === range.key
                ? "inline-flex h-9 items-center rounded-lg bg-brand-600 px-3 text-sm font-medium text-white"
                : "inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas"
            }
          >
            {p.label}
          </Link>
        ))}
        <form action="/insights" method="get" className="flex items-end gap-2">
          <input
            type="date"
            name="from"
            defaultValue={range.from}
            aria-label="From"
            className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm text-ink"
          />
          <input
            type="date"
            name="to"
            defaultValue={range.to}
            aria-label="To"
            className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm text-ink"
          />
          <button
            type="submit"
            className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas"
          >
            Go
          </button>
        </form>
      </div>

      {!insights.hasData ? (
        <Card>
          <EmptyState title="No sales loaded for this period">
            Sales appear here once the day&rsquo;s reports are uploaded on{" "}
            <Link href="/sales-reports" className="font-medium text-brand-700 underline underline-offset-2">
              Sales report entry
            </Link>
            . A show day&rsquo;s figures do not exist until the morning after it ran.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-5">
          {/* ------------------------------------------------ 1. the headline */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Headline
              label="Net revenue"
              value={formatMoneyShort(totals.revenueCents)}
              change={changes.revenue}
              hint="on the period before"
            />
            <Headline
              label="Watches sold"
              value={String(totals.units)}
              change={changes.units}
              hint="on the period before"
            />
            <Headline
              label="Average price"
              value={formatMoney(totals.avgPriceCents)}
              change={changes.avgPrice}
              hint="per watch"
            />
            <Headline
              label="Buyers"
              value={String(totals.buyers)}
              change={changes.buyers}
              hint="distinct"
            />
          </div>

          {insights.latestDay ? (
            <p className="text-sm text-ink-muted">
              Most recent day loaded:{" "}
              <strong className="text-ink">{formatDate(insights.latestDay.dateISO, "long")}</strong>{" "}
              — {formatMoney(insights.latestDay.revenueCents)} from {insights.latestDay.units}{" "}
              watches. Sales arrive the morning after a show, so today&rsquo;s are not in yet.
            </p>
          ) : null}

          {/* ------------------------------------------------ 2. over time */}
          <Card>
            <CardHeader
              title="Revenue by day"
              description={`${insights.daysWithSales} day${insights.daysWithSales === 1 ? "" : "s"} with sales · ${formatMoney(insights.revenuePerActiveDayCents)} on an average selling day`}
            />
            <div className="p-4 pt-2">
              <DailyBars
                points={insights.daily.map((d) => ({ dateISO: d.dateISO, value: d.revenueCents }))}
                format={(v) => formatMoney(v)}
              />
            </div>
          </Card>

          {/* ------------------------------------------------ 3. where it sells */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Which marketplace"
                description="Where the money came from."
              />
              <div className="p-4 pt-2">
                <SplitBar
                  slices={insights.byPlatform.map((p) => ({
                    label: p.key,
                    value: p.revenueCents,
                    units: p.units,
                    color: colourFor(p.key),
                  }))}
                  format={formatMoney}
                />
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Day against night"
                description="Both marketplaces together. This is the one that moves people around a rota."
              />
              <div className="p-4 pt-2">
                <SplitBar
                  slices={insights.bySlot.map((s) => ({
                    label: `${s.key} shows`,
                    value: s.revenueCents,
                    units: s.units,
                    color: s.key === "Day" ? SERIES.brand : SERIES.tiktok,
                  }))}
                  format={formatMoney}
                />
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Every show"
              description="Broken out, so a strong marketplace does not hide a weak show inside it."
            />
            <Table>
              <thead>
                <tr>
                  <Th>Show</Th>
                  <Th>Net revenue</Th>
                  <Th>Watches</Th>
                  <Th>Average price</Th>
                  <Th>Share</Th>
                </tr>
              </thead>
              <tbody>
                {insights.byShow.map((s) => (
                  <tr key={s.key}>
                    <Td className="font-medium">
                      <Badge tone={s.key.toLowerCase().startsWith("tiktok") ? "tiktok" : "ebay"}>
                        {s.key}
                      </Badge>
                    </Td>
                    <Td className="tabular font-semibold">{formatMoney(s.revenueCents)}</Td>
                    <Td className="tabular">{s.units}</Td>
                    <Td className="tabular text-ink-muted">{formatMoney(s.avgPriceCents)}</Td>
                    <Td className="tabular text-ink-muted">{Math.round(s.sharePercent)}%</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          {/* ------------------------------------------------ 4. what sells */}
          <Card>
            <CardHeader
              title="Best sellers"
              description="Most units in this period. 🔥 means it keeps selling — it is in the top tenth by units across everything ever loaded, so it is worth restocking."
            />
            {insights.bestSellers.length === 0 ? (
              <EmptyState title="Nothing sold in this period" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Stock number</Th>
                    <Th>Sold now</Th>
                    <Th>Net revenue</Th>
                    <Th>Average price</Th>
                    <Th>All time</Th>
                  </tr>
                </thead>
                <tbody>
                  {insights.bestSellers.map((m) => (
                    <tr key={m.stockNumber}>
                      <Td className="tabular font-medium">
                        {m.hot ? <span aria-label="keeps selling">🔥 </span> : null}
                        {m.stockNumber}
                      </Td>
                      <Td className="tabular font-semibold">{m.units}</Td>
                      <Td className="tabular">{formatMoney(m.revenueCents)}</Td>
                      <Td className="tabular text-ink-muted">{formatMoney(m.avgPriceCents)}</Td>
                      <Td className="tabular text-ink-muted">{m.allTimeUnits}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {/* ------------------------------------------------ 5. the detail */}
          <Card>
            <CardHeader
              title="Every day"
              description="The figures behind the chart, for checking one back to its source."
            />
            <Table>
              <thead>
                <tr>
                  <Th>Show day</Th>
                  <Th>Net revenue</Th>
                  <Th>Watches</Th>
                  <Th>Average price</Th>
                </tr>
              </thead>
              <tbody>
                {[...insights.daily]
                  .reverse()
                  .filter((d) => d.units > 0)
                  .map((d) => (
                    <tr key={d.dateISO}>
                      <Td className="whitespace-nowrap font-medium">{formatDate(d.dateISO)}</Td>
                      <Td className="tabular font-semibold">{formatMoney(d.revenueCents)}</Td>
                      <Td className="tabular">{d.units}</Td>
                      <Td className="tabular text-ink-muted">
                        {formatMoney(d.units === 0 ? 0 : Math.round(d.revenueCents / d.units))}
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </Card>

          <p className="text-xs text-ink-subtle">
            Net revenue is the price after both discounts — the headline figure in the master
            specification. Shipping and tax are carried separately and are not in it. Where a day
            was uploaded more than once, only the most recent upload counts.
          </p>
        </div>
      )}
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { CalendarRange, Download } from "lucide-react";
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
import { DailyBars, MiniBar, SERIES, SplitBar } from "@/components/charts";
import { requireBoss } from "@/lib/auth/guards";
import { diffDays, formatDate, formatDateRange, isDateISO } from "@/lib/domain/dates";
import { formatChange, formatMoney, formatMoneyShort } from "@/lib/domain/insights";
import type { Change } from "@/lib/domain/insights";
import { getSalesInsights, rangePresets, resolveRange } from "@/lib/server/insights";
import { cn } from "@/lib/utils";

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
 * The sections are ruled and named rather than being a wall of equal cards: five
 * questions in order, so the eye can stop at the first one it came for.
 *
 * Boss only. The shipping director loads the files and packs against them, but
 * what the business took is not her screen.
 */

/** A movement, as a chip: green up, red down, grey when there is nothing to say. */
function Delta({ change: c }: { change: Change }) {
  const up = c.direction === "up";
  const down = c.direction === "down";

  return (
    <span
      className={cn(
        "tabular inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
        up && "bg-ok-50 text-ok-700 ring-ok-200",
        down && "bg-danger-50 text-danger-700 ring-danger-200",
        !up && !down && "bg-canvas text-ink-muted ring-line-strong",
      )}
    >
      {up ? "▲" : down ? "▼" : null}
      {formatChange(c)}
    </span>
  );
}

/**
 * One headline figure.
 *
 * The previous period's own number sits under it rather than only a percentage:
 * "+14%" says nothing about whether the base was a good fortnight or a dead one.
 */
function Headline({
  label,
  value,
  change: c,
  format,
}: {
  label: string;
  value: string;
  change: Change;
  format: (n: number) => string;
}) {
  const bare = c.direction === "new" || c.direction === "none";

  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</p>
      <p className="tabular mt-1.5 text-3xl font-semibold tracking-tight text-ink">{value}</p>
      <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Delta change={c} />
        <span className="tabular text-ink-subtle">
          {bare ? "nothing in the period before" : `vs ${format(c.previous)} before`}
        </span>
      </p>
    </Card>
  );
}

/** A named rule between sections, so the page reads as five questions in order. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{children}</h2>
      <span className="h-px flex-1 bg-line" aria-hidden />
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

  const lengthDays = diffDays(range.from, range.to) + 1;
  const oneDay = lengthDays === 1;

  const colourFor = (key: string) =>
    key.toLowerCase().startsWith("tiktok")
      ? SERIES.tiktok
      : key.toLowerCase().startsWith("ebay")
        ? SERIES.ebay
        : key === "Day"
          ? SERIES.brand
          : SERIES.tiktok;

  const topUnits = insights.bestSellers[0]?.units ?? 0;
  const topDay = Math.max(...insights.daily.map((d) => d.revenueCents), 0);

  return (
    <>
      <PageHeader
        title="Sales insights"
        description={
          <span
            title={`Compared with ${insights.previous.from} to ${insights.previous.to}`}
          >
            {oneDay ? formatDate(range.from, "long") : formatDateRange(range.from, range.to)}
            <span className="text-ink-subtle">
              {" · "}
              {oneDay
                ? `compared with ${formatDate(insights.previous.from)}`
                : `compared with the ${lengthDays} days before`}
            </span>
          </span>
        }
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
      <div className="no-print mb-5 flex flex-wrap items-center gap-2.5">
        {/* One segmented control rather than loose buttons: these are five ways
            of answering the same question, and they should look it. */}
        <div className="inline-flex items-center gap-0.5 rounded-xl border border-line bg-surface p-1 shadow-[0_1px_2px_rgba(16,19,26,0.04)]">
          {presets.map((p) => (
            <Link
              key={p.key}
              href={`/insights?period=${p.key}`}
              title={p.from === p.to ? formatDate(p.from) : formatDateRange(p.from, p.to)}
              aria-current={p.key === range.key ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-colors",
                p.key === range.key
                  ? "bg-brand-600 text-white"
                  : "text-ink-muted hover:bg-canvas hover:text-ink",
              )}
            >
              {p.label}
            </Link>
          ))}
        </div>

        {/* The custom range is one control, not three loose fields beside the
            presets — same height, same corner, and it lights up when it is the
            one in use. */}
        <form
          action="/insights"
          method="get"
          className={cn(
            "inline-flex items-center gap-1 rounded-xl border bg-surface p-1 pl-2.5 shadow-[0_1px_2px_rgba(16,19,26,0.04)]",
            range.key === "custom" ? "border-brand-500 ring-2 ring-brand-100" : "border-line",
          )}
        >
          <CalendarRange className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
          <input
            type="date"
            name="from"
            defaultValue={range.from}
            aria-label="Custom range, from"
            className="tabular h-8 rounded-lg border-0 bg-transparent px-1 text-sm text-ink"
          />
          <span className="text-ink-subtle" aria-hidden>
            –
          </span>
          <input
            type="date"
            name="to"
            defaultValue={range.to}
            aria-label="Custom range, to"
            className="tabular h-8 rounded-lg border-0 bg-transparent px-1 text-sm text-ink"
          />
          <button
            type="submit"
            className="inline-flex h-8 items-center rounded-lg bg-canvas px-3 text-sm font-medium text-ink transition-colors hover:bg-line"
          >
            Apply
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
              format={formatMoneyShort}
            />
            <Headline
              label="Watches sold"
              value={String(totals.units)}
              change={changes.units}
              format={(n) => String(n)}
            />
            <Headline
              label="Average price"
              value={formatMoney(totals.avgPriceCents)}
              change={changes.avgPrice}
              format={formatMoney}
            />
            <Headline
              label="Distinct buyers"
              value={String(totals.buyers)}
              change={changes.buyers}
              format={(n) => String(n)}
            />
          </div>

          {insights.latestDay ? (
            <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-sm text-ink-muted">
              <strong className="font-semibold text-ink">Most recent day loaded:</strong>{" "}
              {formatDate(insights.latestDay.dateISO, "long")} —{" "}
              <span className="tabular">{formatMoney(insights.latestDay.revenueCents)}</span> from{" "}
              <span className="tabular">{insights.latestDay.units}</span> watches. Sales arrive the
              morning after a show, so today&rsquo;s are not in yet.
            </div>
          ) : null}

          {/* ------------------------------------------------ 2. over time */}
          {insights.daily.length >= 3 ? (
            <>
              <SectionTitle>Over time</SectionTitle>
              <Card>
                <CardHeader
                  title="Revenue by day"
                  description={`${insights.daysWithSales} day${insights.daysWithSales === 1 ? "" : "s"} with sales · ${formatMoney(insights.revenuePerActiveDayCents)} on an average selling day`}
                />
                <div className="p-4 pt-3">
                  <DailyBars
                    points={insights.daily.map((d) => ({
                      dateISO: d.dateISO,
                      value: d.revenueCents,
                    }))}
                    format={(v) => formatMoney(v)}
                  />
                </div>
              </Card>
            </>
          ) : null}

          {/* ------------------------------------------------ 3. where it sells */}
          <SectionTitle>Where it sells</SectionTitle>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Which marketplace" description="Where the money came from." />
              <div className="p-4 pt-3">
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
              <div className="p-4 pt-3">
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
                    <Td>
                      <span className="flex items-center gap-2">
                        <MiniBar
                          value={s.sharePercent}
                          max={100}
                          color={colourFor(s.key)}
                        />
                        <span className="tabular text-ink-muted">
                          {Math.round(s.sharePercent)}%
                        </span>
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          {/* ------------------------------------------------ 4. what sells */}
          <SectionTitle>What sells</SectionTitle>
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
                      <Td className="font-medium">
                        <span className="flex items-center gap-1.5">
                          <span className="w-4 shrink-0" aria-hidden>
                            {m.hot ? "🔥" : null}
                          </span>
                          <span className="tabular">{m.stockNumber}</span>
                          {m.hot ? <span className="sr-only">keeps selling</span> : null}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex items-center gap-2.5">
                          <span className="tabular w-8 shrink-0 text-right font-semibold">
                            {m.units}
                          </span>
                          <MiniBar value={m.units} max={topUnits} />
                        </span>
                      </Td>
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
          {insights.daysWithSales > 1 ? (
            <>
              <SectionTitle>The detail</SectionTitle>
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
                          <Td>
                            <span className="flex items-center gap-2.5">
                              <span className="tabular shrink-0 font-semibold">
                                {formatMoney(d.revenueCents)}
                              </span>
                              <MiniBar value={d.revenueCents} max={topDay} />
                            </span>
                          </Td>
                          <Td className="tabular">{d.units}</Td>
                          <Td className="tabular text-ink-muted">
                            {formatMoney(d.units === 0 ? 0 : Math.round(d.revenueCents / d.units))}
                          </Td>
                        </tr>
                      ))}
                  </tbody>
                </Table>
              </Card>
            </>
          ) : null}

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

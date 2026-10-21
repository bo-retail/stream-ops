import type { Metadata } from "next";
import Link from "next/link";
import { CalendarRange } from "lucide-react";
import { Alert, Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { DailyBars } from "@/components/charts";
import { SortableTable, type SortColumn } from "@/components/sortable-table";
import { WatchImage } from "@/components/watch-image";
import { requireBoss } from "@/lib/auth/guards";
import { datesBetween, diffDays, formatDate, formatDateRange, isDateISO } from "@/lib/domain/dates";
import { slotOfSalesShow } from "@/lib/domain/imports/types";
import { formatMoney, formatMoneyShort } from "@/lib/domain/insights";
import { averagePrice, emptyFigures, grossMargin, marginRate, type Figures } from "@/lib/domain/morning";
import { SLOW_MAX_MARGIN, SLOW_MAX_PER_SHOW, SLOW_WINDOW_DAYS, marginMovement, moneyMovement, type ModelProfit, type Movement } from "@/lib/domain/profit";
import { PLATFORM_SHORT, slotShort } from "@/lib/domain/types";
import { rangePresets, resolveRange } from "@/lib/server/insights";
import { getProfitability } from "@/lib/server/profit";
import { cn } from "@/lib/utils";
import { formatCount } from "@/lib/domain/insights";

export const metadata: Metadata = { title: "Profitability" };

/**
 * Gross margin on watches: what they sold for against what they cost us.
 *
 * Daniel's list (September): revenue, cost of goods, gross margin, average
 * price, units — and slow movers. No goals and no fees or wages (Samuel,
 * 21 October). Each sale is costed exactly as Morning numbers costs it: the
 * cost saved when it sold, else the model's cost today. Admins only: cost is
 * for admins only.
 */

const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 1000) / 10}%`);
const showName = (show: string) => {
  const platform = show.toLowerCase().startsWith("ebay") ? "EBAY" : "TIKTOK";
  return `${PLATFORM_SHORT[platform]} ${slotShort(slotOfSalesShow(show))}`;
};

function Delta({ c, invert = false }: { c: Movement; invert?: boolean }) {
  const good = invert ? c.direction === "down" : c.direction === "up";
  const bad = invert ? c.direction === "up" : c.direction === "down";
  return (
    <span
      className={cn(
        "tabular inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
        good && "bg-ok-50 text-ok-700 ring-ok-200",
        bad && "bg-danger-50 text-danger-700 ring-danger-200",
        !good && !bad && "bg-canvas text-ink-muted ring-line-strong",
      )}
    >
      {c.direction === "up" ? "▲ " : c.direction === "down" ? "▼ " : ""}
      {c.label}
    </span>
  );
}

function Headline({ label, value, c, before, invert }: { label: string; value: string; c?: Movement; before?: string; invert?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-[13px] font-semibold text-ink-muted">{label}</p>
      <p className="tabular mt-1.5 text-2xl font-semibold tracking-tight text-ink">{value}</p>
      {c ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Delta c={c} invert={invert} />
          {before ? <span className="tabular text-ink-subtle">vs {before} before</span> : null}
        </p>
      ) : null}
    </Card>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{children}</h2>
      <span className="h-px flex-1 bg-line" aria-hidden />
    </div>
  );
}

const FIGURE_HEADS = ["Revenue", "Units", "Avg price", "Cost of goods", "Gross profit", "Margin"];

export default async function ProfitabilityPage({
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
  const p = await getProfitability(range.from, range.to);
  const t = p.current.total;
  const prev = p.previousTotal;
  const lengthDays = diffDays(range.from, range.to) + 1;

  const models = [...p.current.byModel.values()];
  const name = (m: string) => p.models.get(m);
  // Thinnest margins among watches that sold a few, so one odd sale is not a verdict.
  const thinnest = models
    .filter((m) => m.costedRevenueCents > 0 && m.units >= 3 && m.costedRevenueCents === m.revenueCents)
    .sort((a, b) => (marginRate(a) ?? 0) - (marginRate(b) ?? 0))
    .slice(0, 15);
  const belowCost = models.filter((m) => m.belowCostUnits > 0).sort((a, b) => b.belowCostUnits - a.belowCostUnits);
  const shows = [...p.current.byShow.entries()].sort((a, b) => b[1].revenueCents - a[1].revenueCents);
  const platforms = [...p.current.byPlatform.entries()].sort((a, b) => b[1].revenueCents - a[1].revenueCents);
  const days = datesBetween(range.from, range.to);
  const lossDays = days.filter((d) => grossMargin(p.current.byDay.get(d) ?? emptyFigures()) < 0);

  const notes: string[] = [];
  if (t.uncostedUnits > 0) notes.push(`${t.uncostedUnits.toLocaleString("en-US")} unit(s) of a model with no cost: their revenue counts, the margin leaves them out. Load the Invicta master to give them one.`);
  if (t.unnamedUnits > 0) notes.push(`${t.unnamedUnits.toLocaleString("en-US")} random pull(s) not named yet: revenue counts, margin leaves them out until packing names the watch.`);
  if (t.cancelledUnits > 0) notes.push(`${t.cancelledUnits.toLocaleString("en-US")} cancelled after payment (${formatMoney(t.cancelledCents)}) are left out.`);

  const modelContent = (m: string) => {
    const info = name(m);
    return (
      <div className="flex items-center gap-2.5">
        <WatchImage url={info?.picture ?? ""} model={m} size={36} />
        <div className="min-w-0">
          <p className="tabular font-medium text-ink">{m}</p>
          {info?.description ? <p className="max-w-xs truncate text-xs text-ink-subtle">{info.description}</p> : null}
        </div>
      </div>
    );
  };
  // Every table sorts by clicking its headings, as in Excel (Samuel, 21 October).
  const figureColumns: SortColumn[] = FIGURE_HEADS.map((label) => ({ label, align: "right" }));
  const figureCells = (f: Figures): React.ReactNode[] => {
    const r = marginRate(f);
    return [
      <span key="r" className="tabular">{formatMoney(f.revenueCents)}</span>,
      <span key="u" className="tabular">{f.units.toLocaleString("en-US")}</span>,
      <span key="a" className="tabular text-ink-muted">{averagePrice(f) === null ? "—" : formatMoney(averagePrice(f)!)}</span>,
      <span key="c" className="tabular text-ink-muted">{formatMoney(f.cogsCents)}</span>,
      <span key="g" className="tabular">{formatMoney(grossMargin(f))}</span>,
      <span key="m" className={cn("tabular font-semibold", r !== null && r < 0 && "text-danger-600")}>{pct(r)}</span>,
    ];
  };
  const figureSort = (f: Figures) => [f.revenueCents, f.units, averagePrice(f), f.cogsCents, grossMargin(f), marginRate(f)];
  const modelTable = (rows: ModelProfit[], opts: { initial?: number; limit?: number } = {}) => (
    <SortableTable
      columns={[{ label: "Watch" }, ...figureColumns]}
      rows={rows.map((m) => ({ key: m.model, cells: [modelContent(m.model), ...figureCells(m)], sort: [m.model, ...figureSort(m)] }))}
      initial={opts.initial}
      limit={opts.limit}
    />
  );

  return (
    <>
      <PageHeader
        title="Profitability"
        description={`Watches · ${lengthDays === 1 ? formatDate(range.from, "long") : formatDateRange(range.from, range.to)} · gross margin: what they sold for, less what they cost us`}
      />

      <div className="no-print mb-5 flex flex-wrap items-center gap-2.5">
        <div className="inline-flex items-center gap-0.5 rounded-xl border border-line bg-surface p-1">
          {presets.map((pr) => (
            <Link
              key={pr.key}
              href={`/profitability?period=${pr.key}`}
              aria-current={pr.key === range.key ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-colors",
                pr.key === range.key ? "bg-brand-600 text-white" : "text-ink-muted hover:bg-canvas hover:text-ink",
              )}
            >
              {pr.label}
            </Link>
          ))}
        </div>
        <form
          action="/profitability"
          method="get"
          className={cn(
            // Wraps on a phone: the two dates and Apply are wider than 375px in one row.
            "inline-flex max-w-full flex-wrap items-center gap-1 rounded-xl border bg-surface p-1 pl-2.5",
            range.key === "custom" ? "border-brand-500 ring-2 ring-brand-100" : "border-line",
          )}
        >
          <CalendarRange className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
          <input type="date" name="from" defaultValue={range.from} aria-label="From" className="tabular h-8 rounded-lg border-0 bg-transparent px-1 text-sm text-ink" />
          <span className="text-ink-subtle" aria-hidden>–</span>
          <input type="date" name="to" defaultValue={range.to} aria-label="To" className="tabular h-8 rounded-lg border-0 bg-transparent px-1 text-sm text-ink" />
          <button type="submit" className="inline-flex h-8 items-center rounded-lg bg-canvas px-3 text-sm font-medium text-ink hover:bg-line">
            Apply
          </button>
        </form>
      </div>

      {t.units === 0 && t.cancelledUnits === 0 ? (
        <Card>
          <EmptyState title="No watch sales in this period">Pick a longer period, or check the day&apos;s reports are uploaded.</EmptyState>
        </Card>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <Headline label="Revenue" value={formatMoneyShort(t.revenueCents)} c={moneyMovement(t.revenueCents, prev.revenueCents)} before={formatMoneyShort(prev.revenueCents)} />
            <Headline label="Cost of goods" value={formatMoneyShort(t.cogsCents)} c={moneyMovement(t.cogsCents, prev.cogsCents)} before={formatMoneyShort(prev.cogsCents)} invert />
            <Headline label="Gross profit" value={formatMoneyShort(grossMargin(t))} c={moneyMovement(grossMargin(t), grossMargin(prev))} before={formatMoneyShort(grossMargin(prev))} />
            <Headline
              label="Margin"
              value={pct(marginRate(t))}
              c={marginMovement(marginRate(t), marginRate(prev))}
              before={pct(marginRate(prev))}
            />
            <Headline label="Avg price" value={averagePrice(t) === null ? "—" : formatMoney(averagePrice(t)!)} c={moneyMovement(averagePrice(t) ?? 0, averagePrice(prev) ?? 0)} before={averagePrice(prev) === null ? "—" : formatMoney(averagePrice(prev)!)} />
            <Headline label="Units" value={t.units.toLocaleString("en-US")} c={moneyMovement(t.units, prev.units)} before={prev.units.toLocaleString("en-US")} />
          </div>
          <p className="text-xs text-ink-subtle">
            Compared with {formatDateRange(p.previous.from, p.previous.to)}. The margin is worked out on the units that have a
            cost. Revenue can be a little lower than Sales insights: orders cancelled after payment are taken out here. A watch
            returned later still counts on the day it sold.
          </p>

          {notes.length > 0 ? (
            <Alert tone={t.uncostedUnits + t.unnamedUnits > 0 ? "warn" : "info"}>
              <ul className="list-disc space-y-0.5 pl-5">
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <SectionTitle>Where the margin is</SectionTitle>
          <div className="grid gap-5 xl:grid-cols-2">
            {[
              { title: "By platform", rows: platforms.map(([k, f]) => [PLATFORM_SHORT[k as "TIKTOK" | "EBAY"] ?? k, f] as const) },
              { title: "By show", rows: shows.map(([k, f]) => [showName(k), f] as const) },
            ].map((block) => (
              <Card key={block.title}>
                <CardHeader title={block.title} />
                <SortableTable
                  columns={[{ label: block.title === "By show" ? "Show" : "Platform" }, ...figureColumns]}
                  rows={block.rows.map(([label, f], i) => ({
                    // By its place in the list, which stays with the row as it sorts: two
                    // raw show names can read the same once tidied.
                    key: `${i}`,
                    cells: [<span key="l" className="whitespace-nowrap font-medium">{label}</span>, ...figureCells(f)],
                    sort: [label, ...figureSort(f)],
                  }))}
                />
              </Card>
            ))}
          </div>

          <SectionTitle>Over time</SectionTitle>
          <Card>
            <CardHeader title="Gross profit by day" description="The bars are each day; the line is the trend." />
            <div className="px-4 pb-4">
              <DailyBars
                points={days.map((d) => ({ dateISO: d, value: Math.max(0, grossMargin(p.current.byDay.get(d) ?? emptyFigures())) }))}
                format={(v) => formatMoney(v)}
              />
              {lossDays.length > 0 ? (
                <p className="mt-2 text-xs font-medium text-danger-700">
                  {lossDays.length === 1 ? "1 day" : `${lossDays.length} days`} lost money and show as $0 on the chart:{" "}
                  {lossDays.map((d) => `${formatDate(d)} (${formatMoney(grossMargin(p.current.byDay.get(d)!))})`).join(", ")}.
                </p>
              ) : null}
            </div>
          </Card>

          <SectionTitle>Which watches make money</SectionTitle>
          <div className="space-y-5">
            <Card>
              <CardHeader
                title="All watches"
                description="Opens on the 15 that made the most. Click a heading to sort by it, highest first; click again for lowest first. Sorting ranks every watch, not just the ones shown."
              />
              {modelTable(models, { initial: 5, limit: 15 })}
            </Card>
            <Card>
              <CardHeader title="Thinnest margins" description="The 15 lowest margins among watches that sold 3 or more, every one costed." />
              {thinnest.length === 0 ? <EmptyState title="Nothing sold 3 or more with a cost" /> : modelTable(thinnest)}
            </Card>
            {belowCost.length > 0 ? (
              <Card>
                <CardHeader
                  title={`Sold below cost (${belowCost.length})`}
                  description="Watches with at least one unit sold for less than it cost us."
                />
                <SortableTable
                  columns={[
                    { label: "Watch" },
                    { label: "Below cost", align: "right" },
                    { label: "Of units", align: "right" },
                    { label: "Cost", align: "right" },
                    { label: "Avg price", align: "right" },
                    { label: "Margin", align: "right" },
                  ]}
                  rows={belowCost.map((m) => {
                    const cost = name(m.model)?.costCents ?? null;
                    return {
                      key: m.model,
                      cells: [
                        modelContent(m.model),
                        <span key="b" className="tabular font-semibold text-danger-600">{m.belowCostUnits}</span>,
                        <span key="u" className="tabular">{formatCount(m.units)}</span>,
                        <span key="c" className="tabular text-ink-muted">{cost === null ? "—" : formatMoney(cost)}</span>,
                        <span key="a" className="tabular">{averagePrice(m) === null ? "—" : formatMoney(averagePrice(m)!)}</span>,
                        <span key="m" className="tabular">{pct(marginRate(m))}</span>,
                      ],
                      sort: [m.model, m.belowCostUnits, m.units, cost, averagePrice(m), marginRate(m)],
                    };
                  })}
                />
              </Card>
            ) : null}
          </div>
        </div>
      )}

      <div className="mt-5 space-y-5">
        <SectionTitle>Slow movers</SectionTitle>
        <Card>
          <CardHeader
            title={`Slow movers · ${formatDateRange(p.slowWindow.from, p.slowWindow.to)}`}
            description={`Daniel's rule: ${SLOW_MAX_PER_SHOW} or fewer a show, under ${Math.round(SLOW_MAX_MARGIN * 100)}% margin, over the last ${SLOW_WINDOW_DAYS} days of the period — counting only the shows each sold in. Candidates for a new target price.`}
          />
          {p.slow.length === 0 ? (
            <EmptyState title="No slow movers in these seven days" />
          ) : (
            <SortableTable
              columns={[
                { label: "Watch" },
                { label: "Shows sold in", align: "right" },
                { label: "Units", align: "right" },
                { label: "A show", align: "right" },
                { label: "Margin", align: "right" },
                { label: "Target price", align: "right" },
                { label: "Cost", align: "right" },
              ]}
              rows={p.slow.map((s) => {
                const tp = name(s.model)?.tpCents ?? null;
                const cost = name(s.model)?.costCents ?? null;
                return {
                  key: s.model,
                  cells: [
                    modelContent(s.model),
                    <span key="s" className="tabular">{s.shows}</span>,
                    <span key="u" className="tabular">{formatCount(s.units)}</span>,
                    <span key="a" className="tabular">{Math.round(s.unitsPerShow * 10) / 10}</span>,
                    <span key="m" className={cn("tabular font-semibold", s.margin < 0 ? "text-danger-600" : "text-warn-700")}>{pct(s.margin)}</span>,
                    <span key="t" className="tabular">{tp === null ? "—" : formatMoney(tp)}</span>,
                    <span key="c" className="tabular text-ink-muted">{cost === null ? "—" : formatMoney(cost)}</span>,
                  ],
                  sort: [s.model, s.shows, s.units, s.unitsPerShow, s.margin, tp, cost],
                };
              })}
            />
          )}
          <p className="px-4 py-2.5 text-xs text-ink-subtle">
            <Badge tone="neutral">Watches only</Badge> Diamonds have no master cost yet.
          </p>
        </Card>
      </div>
    </>
  );
}

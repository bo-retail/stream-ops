import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Card, CardHeader, EmptyState, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { addDays, formatDate, isDateISO, todayISO } from "@/lib/domain/dates";
import { formatMoney } from "@/lib/domain/insights";
import {
  SHOW_ORDER,
  averagePrice,
  grossMargin,
  marginRate,
  type Figures,
} from "@/lib/domain/morning";
import { bringStockUpToDateQuietly } from "@/lib/server/deduction";
import { getMorningGoal, getMorningNumbers, latestShowDay } from "@/lib/server/morning";
import { getSettings } from "@/lib/server/settings";
import { DayPicker } from "./day-picker";
import { GoalForm } from "./goal-form";

export const metadata: Metadata = { title: "Morning numbers" };

const pct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);
const money = (c: number | null) => (c === null ? "—" : c < 0 ? `−${formatMoney(-c)}` : formatMoney(c));

/**
 * The morning numbers: a show day's revenue, cost of goods, gross margin,
 * average price and units, per show and in total, against $35,000 a day at
 * 35% unless the goal has been changed. Watches only. Admins and shipping
 * directors (Samuel, 4 October).
 */
export default async function MorningPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const user = await requireShippingDirector();
  const today = todayISO((await getSettings()).timezone);
  const { date: asked } = await searchParams;
  const date = asked && isDateISO(asked) ? asked : ((await latestShowDay(today)) ?? addDays(today, -1));
  // The latest sales taken off first, so as many units as possible carry their cost snapshot.
  await bringStockUpToDateQuietly(user.id, { ifChanged: true });
  const [{ day, week, missingReports, startDate }, goal] = await Promise.all([getMorningNumbers(date), getMorningGoal()]);
  const DAILY_GOAL_CENTS = goal.dailyCents;
  const MARGIN_GOAL = goal.margin;
  const t = day.total;
  const m = marginRate(t);
  const shows = [...SHOW_ORDER, ...[...day.byShow.keys()].filter((s) => !(SHOW_ORDER as readonly string[]).includes(s)).sort()];

  return (
    <>
      <PageHeader
        title="Morning numbers"
        description={`A show day's watch sales: revenue, cost of goods, gross margin, average price and units, against ${formatMoney(DAILY_GOAL_CENTS)} a day at ${pct(MARGIN_GOAL)}.`}
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <DayPicker date={date} />
          <span className="text-sm text-ink-muted">{formatDate(date, "long")}</span>
          <div className="ml-auto">
            <GoalForm dailyDollars={DAILY_GOAL_CENTS / 100} marginPercent={Math.round(MARGIN_GOAL * 10_000) / 100} />
          </div>
        </div>

        {missingReports.length > 0 ? (
          <Alert tone="warn">
            The {missingReports.join(", ")} report{missingReports.length > 1 ? "s are" : " is"} not uploaded yet for this day, so these numbers are
            not the whole day. <Link href="/sales-reports" className="underline">Upload it</Link>.
          </Alert>
        ) : null}

        {t.units === 0 && t.cancelledUnits === 0 ? (
          <Card>
            <EmptyState title="No watch sales for this day">
              {missingReports.length > 0 ? "The reports for its shows are not uploaded yet." : "There were no watch shows, or nothing sold."}
            </EmptyState>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat
                label="Revenue"
                value={formatMoney(t.revenueCents)}
                sub={`${Math.round((t.revenueCents / DAILY_GOAL_CENTS) * 100)}% of the ${formatMoney(DAILY_GOAL_CENTS)} goal`}
                tone={t.revenueCents >= DAILY_GOAL_CENTS ? "ok" : "warn"}
              />
              <Stat label="Gross margin" value={pct(m)} sub={`${money(grossMargin(t))} · goal ${pct(MARGIN_GOAL)}`} tone={m === null ? undefined : m >= MARGIN_GOAL ? "ok" : "warn"} />
              <Stat label="Cost of goods" value={formatMoney(t.cogsCents)} />
              <Stat label="Units" value={t.units} />
              <Stat label="Average price" value={money(averagePrice(t))} />
            </div>

            <Notes f={t} startDate={startDate} date={date} />

            <Card>
              <CardHeader title="By show" />
              <Table>
                <thead>
                  <tr>
                    <Th>Show</Th>
                    <Th className="text-right">Revenue</Th>
                    <Th className="text-right">Share</Th>
                    <Th className="text-right">Units</Th>
                    <Th className="text-right">Avg price</Th>
                    <Th className="text-right">Cost of goods</Th>
                    <Th className="text-right">Gross margin</Th>
                    <Th className="text-right">GM %</Th>
                  </tr>
                </thead>
                <tbody>
                  {shows.map((s) => {
                    const f = day.byShow.get(s);
                    if (!f) {
                      return (
                        <tr key={s}>
                          <Td>{s}</Td>
                          <Td colSpan={7} className="text-ink-subtle">No sales</Td>
                        </tr>
                      );
                    }
                    const r = marginRate(f);
                    return (
                      <tr key={s}>
                        <Td>{s}</Td>
                        <Td className="text-right tabular-nums">{formatMoney(f.revenueCents)}</Td>
                        <Td className="text-right tabular-nums">{t.revenueCents ? `${Math.round((f.revenueCents / t.revenueCents) * 100)}%` : "—"}</Td>
                        <Td className="text-right tabular-nums">{f.units}</Td>
                        <Td className="text-right tabular-nums">{money(averagePrice(f))}</Td>
                        <Td className="text-right tabular-nums">{formatMoney(f.cogsCents)}</Td>
                        <Td className="text-right tabular-nums">{money(grossMargin(f))}</Td>
                        <Td className={`text-right tabular-nums ${r !== null && r < MARGIN_GOAL ? "text-warn-700" : ""}`}>{pct(r)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </Card>
          </>
        )}

        <Card>
          <CardHeader title="The last seven days" description="Each show day against the goal. A day with nothing is a day with no shows or no reports yet." />
          <Table>
            <thead>
              <tr>
                <Th>Day</Th>
                <Th className="text-right">Revenue</Th>
                <Th className="text-right">Of goal</Th>
                <Th className="text-right">Units</Th>
                <Th className="text-right">GM %</Th>
              </tr>
            </thead>
            <tbody>
              {[...week].reverse().map((d) => (
                <tr key={d.date} className={d.date === date ? "bg-canvas" : undefined}>
                  <Td>
                    <Link href={`/inventory/morning?date=${d.date}`} className="underline">{formatDate(d.date)}</Link>
                  </Td>
                  <Td className="text-right tabular-nums">{d.total.units ? formatMoney(d.total.revenueCents) : "—"}</Td>
                  <Td className="text-right tabular-nums">{d.total.units ? `${Math.round((d.total.revenueCents / DAILY_GOAL_CENTS) * 100)}%` : "—"}</Td>
                  <Td className="text-right tabular-nums">{d.total.units || "—"}</Td>
                  <Td className="text-right tabular-nums">{d.total.units ? pct(marginRate(d.total)) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}

/** What the margin rests on, said plainly. */
function Notes({ f, startDate, date }: { f: Figures; startDate: string | null; date: string }) {
  const notes: string[] = [];
  const are = (n: number) => (n > 1 ? `${n} units are` : "1 unit is");
  if (f.estimatedUnits > 0) {
    notes.push(
      startDate === null || startDate > date
        ? `${are(f.estimatedUnits)} costed at the model's cost today: sales were not coming off stock yet on this day, so there is no cost from the moment of sale.`
        : `${are(f.estimatedUnits)} costed at the model's cost today: no cost was recorded when it came off stock (not taken off yet, or the model had no cost then).`,
    );
  }
  if (f.unnamedUnits > 0) {
    notes.push(`${f.unnamedUnits} random pull${f.unnamedUnits > 1 ? "s" : ""} not named yet (no Model # and not scanned): the revenue counts, the margin leaves ${f.unnamedUnits > 1 ? "them" : "it"} out until packing names the watch.`);
  }
  if (f.uncostedUnits > 0) {
    notes.push(`${are(f.uncostedUnits)} of a model with no cost at all: the revenue counts, the margin leaves ${f.uncostedUnits > 1 ? "them" : "it"} out. Add the cost on the model's page, or add the model if it is not in the catalogue yet.`);
  }
  if (f.cancelledUnits > 0) {
    notes.push(`${f.cancelledUnits} cancelled after payment (${formatMoney(f.cancelledCents)}) ${f.cancelledUnits > 1 ? "are" : "is"} left out.`);
  }
  if (notes.length === 0) return null;
  return (
    <Alert tone={f.uncostedUnits + f.unnamedUnits > 0 ? "warn" : "info"}>
      <ul className="list-disc space-y-0.5 pl-5">
        {notes.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </Alert>
  );
}

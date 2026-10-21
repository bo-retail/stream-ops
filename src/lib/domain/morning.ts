/**
 * Inventory, step 6: the morning numbers — a show day's revenue, cost of goods,
 * gross margin, average selling price and units, per show and in total,
 * against the goal of $35,000 a day at 35% (Daniel; both platforms together).
 *
 * Watches only. Revenue is what the reports say was paid, after discounts.
 * Cost is the cost snapshot taken when the watch came off stock (round 6: "a
 * cost snapshot on every sale"), so a later cost correction never rewrites a
 * day already reported. Where there is no snapshot — sales from before the
 * start date, a sale not taken off yet — the model's cost today stands in, and
 * the screen says how many units that is. A unit with no cost at all (a random
 * pull nothing names yet, a model with no cost) is left out of the margin
 * (revenue still counts) and counted. A cancelled order is left out entirely:
 * its watch is back in stock and its money refunded.
 *
 * The units are the ones stock deduction sees, worked out by deduction's own
 * {@link wantedSales}: an order in two uploads is read from the latest, and
 * each unit has deduction's key, so its cost is the one taken off with it.
 *
 * Pure, like everything under `src/lib/domain`.
 */
import { wantedSales, type SaleLine } from "./deduction";
import { catalogueSpelling } from "./inventory";
import type { DateISO } from "./types";

export const DAILY_GOAL_CENTS = 3_500_000;
export const MARGIN_GOAL = 0.35;

/** The four watch shows, in the order the screen lists them. */
export const SHOW_ORDER = ["TikTok AM", "TikTok PM", "eBay AM", "eBay PM"] as const;

/** One line of the reports, as deduction reads it, with what was paid for it after discounts. */
export interface MorningLine extends SaleLine {
  netCents: number;
}

/** A watch that came off stock, by its sale key. */
export interface SoldUnit {
  status: "SOLD" | "SENT" | "UNDONE" | "CANCELLED" | "RETURNED";
  costCents: number | null;
  /**
   * The watch that came off stock for it — for a random pull, the one packing
   * scanned, which the report may not name or may name differently.
   */
  model?: string;
}

export interface Figures {
  revenueCents: number;
  units: number;
  /** Cost of the units that have one. */
  cogsCents: number;
  /** Revenue of the units that have a cost: what the margin is worked out on. */
  costedRevenueCents: number;
  /** Units costed at the model's cost today, not a snapshot from the sale. */
  estimatedUnits: number;
  /** Random pulls nothing names yet: revenue counted, margin left out. */
  unnamedUnits: number;
  /** Models with no cost at all: revenue counted, margin left out. */
  uncostedUnits: number;
  /** Cancelled after payment: left out of everything above. */
  cancelledUnits: number;
  cancelledCents: number;
}

export const emptyFigures = (): Figures => ({
  revenueCents: 0, units: 0, cogsCents: 0, costedRevenueCents: 0, estimatedUnits: 0, unnamedUnits: 0, uncostedUnits: 0,
  cancelledUnits: 0, cancelledCents: 0,
});

export function addFigures(a: Figures, b: Figures): Figures {
  const out = emptyFigures();
  for (const k of Object.keys(out) as (keyof Figures)[]) out[k] = a[k] + b[k];
  return out;
}

/** Gross margin in cents, over the units that have a cost. */
export const grossMargin = (f: Figures) => f.costedRevenueCents - f.cogsCents;
/** Gross margin as a share of the costed revenue, or null when nothing is costed. */
export const marginRate = (f: Figures) => (f.costedRevenueCents > 0 ? grossMargin(f) / f.costedRevenueCents : null);
/** Average selling price, or null with no units. */
export const averagePrice = (f: Figures) => (f.units > 0 ? Math.round(f.revenueCents / f.units) : null);

export interface DayFigures {
  byShow: Map<string, Figures>;
  total: Figures;
}

/**
 * Every day's figures, per show and in total, keyed by show day.
 *
 * `lines` should cover more than the days wanted (deduction's own window), so
 * an order whose latest upload is on another day is read from there; `days`
 * says which days to report.
 */
export function morningFigures(
  lines: MorningLine[],
  sold: ReadonlyMap<string, SoldUnit>,
  costToday: ReadonlyMap<string, number | null>,
  days: readonly DateISO[],
): Map<DateISO, DayFigures> {
  const out = new Map<DateISO, DayFigures>(days.map((d) => [d, { byShow: new Map(), total: emptyFigures() }]));
  for (const u of costedUnits(lines, sold, costToday, days)) {
    const day = out.get(u.day)!;
    day.byShow.set(u.show, addUnit(day.byShow.get(u.show) ?? emptyFigures(), u));
  }
  for (const day of out.values()) day.total = [...day.byShow.values()].reduce(addFigures, emptyFigures());
  return out;
}

/** One watch sold, with what was paid for it and what it cost us — see `costedUnits`. */
export interface CostedUnit {
  day: DateISO;
  show: string;
  platform: SaleLine["platform"];
  /** The model it is, or null for a random pull nothing names yet. */
  model: string | null;
  /** Its share of the line's money, after discounts. */
  cents: number;
  /** What it cost us, or null when there is no cost to be had. */
  costCents: number | null;
  /** Cost from today's catalogue rather than a snapshot taken when it sold. */
  estimated: boolean;
  cancelled: boolean;
}

/**
 * Every watch sold on the days asked for, one by one, priced and costed.
 *
 * The one place a sale's cost is decided, so Morning numbers and the
 * Profitability tab can never disagree: the snapshot taken when it came off
 * stock, else the model's cost today (marked estimated), else none. A
 * cancelled order is marked and carries its money for the count of what was
 * left out.
 */
export function costedUnits(
  lines: MorningLine[],
  sold: ReadonlyMap<string, SoldUnit>,
  costToday: ReadonlyMap<string, number | null>,
  days: readonly DateISO[],
): CostedUnit[] {
  const wanted = new Set(days);
  const out: CostedUnit[] = [];
  // Each line's money shared over its units, the odd cents on the first one seen.
  const seen = new Map<SaleLine, number>();

  for (const w of wantedSales(lines, new Map(), (m) => costToday.has(m), catalogueSpelling(costToday.keys())).wanted) {
    const line = w.line as MorningLine;
    if (!wanted.has(line.showDate)) continue;
    const units = Math.max(1, line.qty);
    const each = Math.floor(line.netCents / units);
    const n = seen.get(line) ?? 0;
    seen.set(line, n + 1);
    const cents = each + (n === 0 ? line.netCents - each * units : 0);

    const sale = sold.get(w.key);
    const cancelled = sale?.status === "CANCELLED";
    // The watch that actually came off stock wins: a random pull packing named,
    // or one packed as a different model than the report said. Decided first,
    // so a cost looked up today is that watch's.
    const model = sale && sale.status !== "UNDONE" && sale.model ? sale.model : w.model;
    let cost = !cancelled && sale && sale.status !== "UNDONE" ? sale.costCents : null;
    let estimated = false;
    if (!cancelled && cost === null && model) {
      cost = costToday.get(model) ?? null;
      estimated = cost !== null;
    }
    out.push({ day: line.showDate, show: line.show, platform: line.platform, model, cents, costCents: cost, estimated, cancelled });
  }
  return out;
}

/** A unit added to a set of figures. */
export function addUnit(f: Figures, u: CostedUnit): Figures {
  const g = { ...f };
  if (u.cancelled) {
    g.cancelledUnits++;
    g.cancelledCents += u.cents;
    return g;
  }
  g.revenueCents += u.cents;
  g.units++;
  if (u.estimated) g.estimatedUnits++;
  if (u.costCents !== null) {
    g.cogsCents += u.costCents;
    g.costedRevenueCents += u.cents;
  } else if (u.model) g.uncostedUnits++;
  else g.unnamedUnits++;
  return g;
}

export interface Goal {
  dailyCents: number;
  /** As a share: 0.35 for 35%. */
  margin: number;
}

/**
 * The goal as typed on the screen: revenue in dollars ("35000", "$35,000"),
 * margin in percent ("35", "35%"). Refused rather than guessed when it is not
 * a sensible number.
 */
export function readGoal(revenue: string, margin: string): { ok: true; goal: Goal } | { ok: false; why: string } {
  // "35,5" is a decimal comma, not thirty-five hundred and five: refused, not guessed.
  if (/,\d{1,2}$/.test(String(revenue).trim())) return { ok: false, why: "Write the daily revenue goal in dollars, like 35000 or $35,000." };
  const dollars = Number(String(revenue).trim().replace(/[$,\s]/g, ""));
  if (!Number.isFinite(dollars) || dollars < 1) return { ok: false, why: "The daily revenue goal must be at least $1." };
  if (dollars > 10_000_000) return { ok: false, why: "That daily revenue goal is too large — check for an extra zero." };
  const percent = Number(String(margin).trim().replace(/[%\s]/g, ""));
  if (!Number.isFinite(percent) || percent < 1 || percent >= 100) return { ok: false, why: "The margin goal must be a percentage from 1 to 99." };
  return { ok: true, goal: { dailyCents: Math.round(dollars * 100), margin: Math.round(percent * 100) / 10_000 } };
}

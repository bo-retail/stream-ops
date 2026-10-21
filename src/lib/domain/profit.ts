/**
 * The Profitability tab: gross margin on watches over any stretch of days.
 *
 * Built on the same costed units as Morning numbers (`costedUnits`), so the two
 * can never disagree about what a sale cost. Gross only — revenue after
 * discounts less what the watches cost us. No goals, no fees or wages (Samuel,
 * 21 October: net profit later, from Flora's report).
 *
 * What Daniel asked to see (September): revenue, cost of goods, gross margin,
 * average price and units; and slow movers — a watch selling two or fewer per
 * show at under 27% margin over seven days, counting only the shows it sold in.
 *
 * Pure, like everything under `src/lib/domain`.
 */
import { addUnit, emptyFigures, marginRate, type CostedUnit, type Figures } from "./morning";
import type { DateISO } from "./types";

export interface ModelProfit extends Figures {
  model: string;
  /** Units that sold for less than they cost us. */
  belowCostUnits: number;
}

export interface ProfitReport {
  total: Figures;
  byPlatform: Map<string, Figures>;
  byShow: Map<string, Figures>;
  byDay: Map<DateISO, Figures>;
  byModel: Map<string, ModelProfit>;
}

export function profitReport(units: readonly CostedUnit[]): ProfitReport {
  let total = emptyFigures();
  const byPlatform = new Map<string, Figures>();
  const byShow = new Map<string, Figures>();
  const byDay = new Map<DateISO, Figures>();
  const byModel = new Map<string, ModelProfit>();
  const into = <K>(m: Map<K, Figures>, k: K, u: CostedUnit) => m.set(k, addUnit(m.get(k) ?? emptyFigures(), u));

  for (const u of units) {
    total = addUnit(total, u);
    into(byPlatform, u.platform, u);
    into(byShow, u.show, u);
    into(byDay, u.day, u);
    if (u.model) {
      const had = byModel.get(u.model) ?? { ...emptyFigures(), model: u.model, belowCostUnits: 0 };
      const next: ModelProfit = { ...addUnit(had, u), model: u.model, belowCostUnits: had.belowCostUnits };
      if (!u.cancelled && u.costCents !== null && u.cents < u.costCents) next.belowCostUnits++;
      byModel.set(u.model, next);
    }
  }
  return { total, byPlatform, byShow, byDay, byModel };
}

export interface SlowMover {
  model: string;
  /** Shows it sold in during the window. */
  shows: number;
  units: number;
  unitsPerShow: number;
  margin: number;
  revenueCents: number;
}

/** Daniel's rule (rounds 2–3): two or fewer a show, under 27% margin, over seven days. */
export const SLOW_MAX_PER_SHOW = 2;
export const SLOW_MAX_MARGIN = 0.27;
export const SLOW_WINDOW_DAYS = 7;

/**
 * Watches that sell slowly at a thin margin over the window — the ones worth a
 * new target price, or a rest. Only the shows a watch sold in count (Daniel:
 * "shown" means sold), so a watch that sat out a show is not marked down for
 * it. A watch with no cost has no margin to judge and is left out; so is a
 * random pull nothing names.
 */
export function slowMovers(units: readonly CostedUnit[], window: readonly DateISO[]): SlowMover[] {
  const days = new Set(window);
  const per = new Map<string, { shows: Set<string>; f: Figures }>();
  for (const u of units) {
    if (!u.model || u.cancelled || !days.has(u.day)) continue;
    const p = per.get(u.model) ?? { shows: new Set<string>(), f: emptyFigures() };
    p.shows.add(`${u.day}|${u.show}`);
    p.f = addUnit(p.f, u);
    per.set(u.model, p);
  }
  const out: SlowMover[] = [];
  for (const [model, { shows, f }] of per) {
    const margin = marginRate(f);
    // Every unit must be costed: a margin from some of them is not the watch's.
    if (margin === null || f.costedRevenueCents !== f.revenueCents) continue;
    const unitsPerShow = f.units / shows.size;
    if (unitsPerShow <= SLOW_MAX_PER_SHOW && margin < SLOW_MAX_MARGIN) {
      out.push({ model, shows: shows.size, units: f.units, unitsPerShow, margin, revenueCents: f.revenueCents });
    }
  }
  return out.sort((a, b) => a.margin - b.margin || a.model.localeCompare(b.model));
}

/** A movement as the page shows it: which way, and the words on the chip. */
export interface Movement {
  direction: "up" | "down" | "flat" | "none";
  label: string;
}

/**
 * A money figure against the period before. A percentage only means something
 * against a positive figure: from a loss to a profit is "up", not "−350%".
 */
export function moneyMovement(current: number, previous: number): Movement {
  if (current === 0 && previous === 0) return { direction: "none", label: "—" };
  if (previous <= 0) {
    if (current === previous) return { direction: "flat", label: "level" };
    return { direction: current > previous ? "up" : "down", label: previous === 0 ? "new" : current > previous ? "up" : "down" };
  }
  const percent = ((current - previous) / previous) * 100;
  if (Math.abs(percent) < 0.1) return { direction: "flat", label: "level" };
  const rounded = Math.abs(percent) >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10;
  return { direction: percent > 0 ? "up" : "down", label: `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}%` };
}

/**
 * A margin against the period before, in percentage points: 30% to 33% is
 * "+3.0 pts", never "+10%".
 */
export function marginMovement(current: number | null, previous: number | null): Movement {
  if (current === null || previous === null) return { direction: "none", label: "—" };
  const points = (current - previous) * 100;
  if (Math.abs(points) < 0.05) return { direction: "flat", label: "level" };
  return { direction: points > 0 ? "up" : "down", label: `${points > 0 ? "+" : "−"}${Math.abs(points).toFixed(1)} pts` };
}

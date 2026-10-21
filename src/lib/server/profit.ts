import "server-only";
import { prisma } from "@/lib/db";
import { addDays, datesBetween } from "@/lib/domain/dates";
import { previousRange } from "@/lib/domain/insights";
import { costedUnits, type Figures } from "@/lib/domain/morning";
import { SLOW_WINDOW_DAYS, profitReport, slowMovers, type ProfitReport, type SlowMover } from "@/lib/domain/profit";
import type { DateISO } from "@/lib/domain/types";
import { picturesFor } from "./inventory";
import { loadSaleInputs } from "./morning";

export interface ModelInfo {
  description: string;
  tpCents: number | null;
  costCents: number | null;
  picture: string;
}

export interface Profitability {
  from: DateISO;
  to: DateISO;
  previous: { from: DateISO; to: DateISO };
  current: ProfitReport;
  /** The same figures for the stretch just before, for the movement on each. */
  previousTotal: Figures;
  /** Daniel's slow movers, over the seven days ending on `to`. */
  slow: SlowMover[];
  slowWindow: { from: DateISO; to: DateISO };
  models: Map<string, ModelInfo>;
}

/**
 * Gross margin on watches for a range, the range before it, and the slow
 * movers of its last seven days — one read of the sales for all three.
 */
export async function getProfitability(from: DateISO, to: DateISO): Promise<Profitability> {
  const previous = previousRange(from, to);
  const slowFrom = addDays(to, -(SLOW_WINDOW_DAYS - 1));
  const earliest = [previous.from, slowFrom, from].sort()[0];

  const { lines, sold, costToday } = await loadSaleInputs(earliest, to);
  const units = costedUnits(lines, sold, costToday, datesBetween(earliest, to));

  const inRange = (a: DateISO, b: DateISO) => units.filter((u) => u.day >= a && u.day <= b);
  const current = profitReport(inRange(from, to));
  const previousTotal = profitReport(inRange(previous.from, previous.to)).total;
  const slow = slowMovers(units, datesBetween(slowFrom, to));

  const wanted = [...new Set([...current.byModel.keys(), ...slow.map((s) => s.model)])];
  const [products, pictures] = await Promise.all([
    wanted.length
      ? prisma.product.findMany({
          where: { model: { in: wanted } },
          select: { model: true, description: true, tpCents: true, costCents: true },
        })
      : Promise.resolve([]),
    picturesFor(wanted),
  ]);
  const models = new Map<string, ModelInfo>(
    products.map((p) => [
      p.model,
      { description: p.description, tpCents: p.tpCents, costCents: p.costCents, picture: pictures.get(p.model) ?? "" },
    ]),
  );

  return { from, to, previous, current, previousTotal, slow, slowWindow: { from: slowFrom, to }, models };
}

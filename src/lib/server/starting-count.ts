import "server-only";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { toDbDate } from "@/lib/domain/dates";
import type { DateISO } from "@/lib/domain/types";
import {
  COUNTED_HEADINGS,
  COUNTED_LABEL,
  COUNTED_PLACES,
  badModelNumber,
  catalogueSpelling,
  normaliseModel,
  parseQty,
  startingCountLines,
} from "@/lib/domain/inventory";
import type { CountedPlace } from "@/lib/domain/inventory";
import { sheetRows } from "@/lib/domain/inventory-sheets";
import type { SheetRows } from "@/lib/domain/inventory-sheets";
import { balancesFor, zero } from "./inventory";

/**
 * The starting count: inventory begins again from one sheet.
 *
 * Samuel, 10/14: "we got way too complicated too fast" — inventory is the
 * SKU, what is Sellable, TT sample, eBay sample and Random pulls, and the
 * sales report subtracting from it. Whatever stock the app held before does
 * not matter: the sheet is the truth. So a starting count
 *
 *   - sets every model's four places to exactly what the sheet says, blank as
 *     none, and every model the sheet does not list to zero
 *   - empties the places the simple inventory does not keep (damaged; sold,
 *     waiting to ship)
 *   - closes every sale the old stock had taken off, so none of them can put
 *     a watch back or take one off again — except that sales from the start
 *     date on are then taken off again, from the new numbers
 *   - sets the show day sales start coming off from
 *
 * All of it in one transaction, or none of it.
 */

export interface StartingEntry {
  model: string;
  counted: Partial<Record<CountedPlace, number>>;
  description: string;
  where: string;
}

/** Reads a filled-in starting count sheet. Every problem listed; nothing saved until none. */
export async function readStartingCount(
  buffer: ArrayBuffer,
): Promise<{ entries: StartingEntry[]; problems: string[]; notes: string[] }> {
  let sheets: SheetRows;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    sheets = sheetRows(wb, (c) => /^model$/i.test(c));
  } catch {
    return { entries: [], problems: ["That is not an Excel (.xlsx) file. Download the starting count sheet and fill that in."], notes: [] };
  }
  if (sheets.length === 0) return { entries: [], problems: ['No tab has a "Model" column. Is this the count sheet?'], notes: [] };

  const problems: string[] = [];
  const notes: string[] = [];
  const byModel = new Map<string, StartingEntry>();
  let damagedSeen = false;

  for (const { sheet, rows } of sheets) {
    if (rows.length === 0) continue;
    const headings = [...new Set(rows.flatMap((r) => Object.keys(r.values)))];
    const column = (place: CountedPlace) =>
      headings.find((h) => COUNTED_HEADINGS[place].includes(h.trim().toLowerCase()));
    const missing = COUNTED_PLACES.filter((p) => column(p) === undefined);
    // A tab with none of the four columns is not a count — a notes tab, a list — and is left alone.
    if (missing.length === COUNTED_PLACES.length) {
      notes.push(`The "${sheet}" tab has none of the count columns, so it was not read.`);
      continue;
    }
    if (missing.length > 0) {
      problems.push(
        `The "${sheet}" tab has no ${missing.map((p) => `"${COUNTED_LABEL[p]}"`).join(", ")} column. ` +
          `Use the starting count sheet as downloaded, without renaming its columns.`,
      );
      continue;
    }
    if (headings.some((h) => h.trim().toLowerCase() === "damaged")) damagedSeen = true;
    const key = (...names: string[]) => headings.find((h) => names.includes(h.trim().toLowerCase()));
    const modelKey = key("model")!;
    const whatKey = key("description", "what it is");

    for (const { line, values } of rows) {
      const model = normaliseModel(values[modelKey]);
      const where = `${sheet}, row ${line}`;
      const counted: Partial<Record<CountedPlace, number>> = {};
      for (const place of COUNTED_PLACES) {
        const r = parseQty(values[column(place)!]);
        if (r.kind === "ok") counted[place] = r.qty;
        if (r.kind === "bad") problems.push(`${where}${model ? ` (${model})` : ""}: ${COUNTED_LABEL[place]}: ${r.why}.`);
      }
      const any = Object.keys(counted).length > 0;
      if (model === "") {
        if (any) problems.push(`${where}: numbers but no model number.`);
        continue;
      }
      if (!any) continue; // all blank: none of it, like a model not on the sheet
      const seen = byModel.get(model);
      if (seen) {
        // Counted in two spots: added together, place by place.
        for (const place of COUNTED_PLACES) {
          if (counted[place] !== undefined) seen.counted[place] = (seen.counted[place] ?? 0) + counted[place]!;
        }
        notes.push(`${model} was on two rows (${seen.where} and ${where}): they were added together.`);
        continue;
      }
      byModel.set(model, {
        model,
        counted,
        where,
        description: whatKey ? String(values[whatKey] ?? "").trim() : "",
      });
    }
  }
  if (damagedSeen) notes.push('The "Damaged" column was not read: the inventory keeps Sellable, TT sample, eBay sample and Random pulls only.');
  return { entries: [...byModel.values()], problems, notes };
}

export interface StartingResult {
  ok: boolean;
  problems: string[];
  /** Models with something counted. */
  models: number;
  pieces: number;
  /** Models the sheet added to the catalogue. */
  added: string[];
  /** Models that had stock before and are not on the sheet, now zero. */
  zeroed: number;
  /** Old sales closed. */
  closedSales: number;
}

/** Inventory starts again from `entries`; sales come off from `startDate`. */
export async function saveStartingCount(
  userId: string,
  entries: StartingEntry[],
  startDate: DateISO,
  source: string,
): Promise<StartingResult> {
  const fail = (problems: string[]): StartingResult => ({ ok: false, problems, models: 0, pieces: 0, added: [], zeroed: 0, closedSales: 0 });

  const entryId = randomUUID();
  return prisma.$transaction(
    async (tx) => {
      // The same lock every count and stock change takes: nothing moves stock meanwhile.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;

      const products = await tx.product.findMany({ select: { id: true, model: true } });
      const idOf = new Map(products.map((p) => [p.model, p.id]));

      /*
        The catalogue's own spelling: Excel drops leading zeros, so a "71"
        typed on the sheet is the catalogue's 0071, not a new watch. Two rows
        that turn out to be one model are added together.
      */
      const spell = catalogueSpelling(idOf.keys());
      const merged = new Map<string, StartingEntry>();
      for (const e of entries) {
        const model = spell(e.model);
        const seen = merged.get(model);
        if (!seen) {
          merged.set(model, { ...e, model, counted: { ...e.counted } });
          continue;
        }
        for (const place of COUNTED_PLACES) {
          if (e.counted[place] !== undefined) seen.counted[place] = (seen.counted[place] ?? 0) + e.counted[place]!;
        }
      }
      const counting = [...merged.values()];

      // Only a watch the catalogue lacks is checked as a model number: one
      // already in it is what the catalogue calls it.
      const problems = counting
        .filter((e) => !idOf.has(e.model) && Object.values(e.counted).some((q) => (q ?? 0) > 0))
        .map((e) => ({ e, bad: badModelNumber(e.model) }))
        .filter((x) => x.bad !== null)
        .map(({ e, bad }) => `${e.where}: ${bad}${/[.?!]$/.test(bad!) ? "" : "."}`);
      if (problems.length > 0) return fail(problems);

      const added: string[] = [];
      for (const e of counting) {
        if (idOf.has(e.model)) continue;
        if (!Object.values(e.counted).some((q) => (q ?? 0) > 0)) continue;
        const created = await tx.product.create({
          data: { model: e.model, description: e.description, needsDetails: true, active: true },
          select: { id: true },
        });
        idOf.set(e.model, created.id);
        added.push(e.model);
      }

      const sheet = new Map(counting.filter((e) => idOf.has(e.model)).map((e) => [idOf.get(e.model)!, e]));
      const current = await balancesFor(tx);
      let zeroed = 0;
      const lines = [...idOf.values()].flatMap((productId) => {
        const before = current.get(productId) ?? zero();
        const entry = sheet.get(productId);
        if (!entry && Object.values(before).some((q) => q !== 0)) zeroed++;
        return startingCountLines(before, entry?.counted ?? {}).map((l) => ({
          productId,
          place: l.place,
          qty: l.qty,
          countedQty: l.counted,
          kind: "COUNT" as const,
          note: "Starting count",
          entryId,
          byId: userId,
        }));
      });
      if (lines.length > 0) await tx.stockMove.createMany({ data: lines });

      // Counted on the shelf: here, so a model we sell.
      const here = [...sheet.entries()].filter(([, e]) => Object.values(e.counted).some((q) => (q ?? 0) > 0)).map(([id]) => id);
      if (here.length > 0) await tx.product.updateMany({ where: { id: { in: here }, active: false }, data: { active: true } });

      /*
        Every sale the old stock took off, closed. "Undone" is the state the
        deduction reads as "not taken off": a closed sale from the start date
        on is taken off again by the next run — from the new numbers, once —
        and one from before it is never looked at again. Cancelled and
        returned ones were set by hand and stay as they are.
      */
      const closed = await tx.stockSale.updateMany({
        where: { status: { in: ["SOLD", "SENT"] } },
        data: { status: "UNDONE" },
      });

      await tx.settings.update({ where: { id: "singleton" }, data: { inventoryStartDate: toDbDate(startDate) } });

      const pieces = [...sheet.values()].reduce(
        (n, e) => n + COUNTED_PLACES.reduce((m, p) => m + (e.counted[p] ?? 0), 0),
        0,
      );
      const models = [...sheet.values()].filter((e) => Object.values(e.counted).some((q) => (q ?? 0) !== 0)).length;

      await tx.auditLog.create({
        data: {
          entityType: "StockMove",
          entityId: entryId,
          action: "STARTING_COUNT",
          actorId: userId,
          summary:
            `Starting count (${source}): ${models} model(s), ${pieces} piece(s); ${zeroed} model(s) not on the sheet set to zero; ` +
            `${closed.count} old sale(s) closed; sales come off from ${startDate}` +
            (added.length > 0 ? `; ${added.length} new model(s) added: ${added.join(", ")}` : ""),
        },
      });

      return { ok: true, problems: [], models, pieces, added, zeroed, closedSales: closed.count };
    },
    { timeout: 180_000, maxWait: 30_000 },
  );
}

/** The starting count sheet: every model, the four places, blank to fill in. */
export async function startingCountSheet(today: string): Promise<ArrayBuffer> {
  const products = await prisma.product.findMany({ orderBy: { model: "asc" }, select: { model: true, description: true } });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Count", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.getCell("A1").value =
    `Starting count, downloaded ${today}. Write how many of each model are in each place; blank means none. ` +
    `A watch not on the list: add it at the bottom with its model number. Every model left blank or not listed becomes zero.`;
  ws.getCell("A1").font = { italic: true, color: { argb: "FF5B6472" } };
  ws.getRow(2).values = ["Model", "Description", ...COUNTED_PLACES.map((p) => COUNTED_LABEL[p])];
  ws.getRow(2).font = { bold: true };
  ws.columns = [{ width: 14 }, { width: 48 }, ...COUNTED_PLACES.map(() => ({ width: 13 }))];
  for (const p of products) ws.addRow([p.model, p.description]);
  // Model numbers as text, so Excel never turns them into something else.
  ws.getColumn(1).numFmt = "@";
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

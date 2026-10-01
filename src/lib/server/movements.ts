import "server-only";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { PLACES, PLACE_LABEL } from "@/lib/domain/inventory";
import type { Place } from "@/lib/domain/inventory";
import { sheetRows } from "@/lib/domain/inventory-sheets";
import {
  ADJUST_COLUMNS,
  ADJUST_REASONS,
  MOVE_COLUMNS,
  MOVE_REASONS,
  RETURN_COLUMNS,
  RETURN_PLACES,
  RETURN_TYPES,
  prompts,
  readAdjustment,
  readMove,
  readReturn,
} from "@/lib/domain/movements";
import type { Adjustment, Move, Prompt, ReturnRow, Row } from "@/lib/domain/movements";
import { getStartDate } from "./deduction";
import { balancesFor, picturesFor, zero } from "./inventory";

/**
 * Inventory, step 4: moves, adjustments, returns and cancellations.
 *
 * Typed on the movements page or uploaded on a template — both come here, are
 * checked the same way, and are saved all or nothing. Each save is one
 * StockEntry, so a mistaken one can be undone as a whole: undoing writes the
 * opposite stock lines, it never deletes any. Every write holds the stock lock.
 */

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
const lockStock = (tx: Tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;
const TX = { timeout: 120_000, maxWait: 30_000 };

export type Kind = "MOVES" | "ADJUSTMENTS" | "RETURNS";
export interface SaveResult {
  ok: boolean;
  saved: number;
  problems: string[];
  /** One line per row saved, for the person to check. */
  done: string[];
}
const fail = (problems: string[]): SaveResult => ({ ok: false, saved: 0, problems, done: [] });

async function productsFor(tx: Tx, models: string[]) {
  const found = await tx.product.findMany({ where: { model: { in: [...new Set(models)] } }, select: { id: true, model: true, costCents: true } });
  return new Map(found.map((p) => [p.model, p]));
}

const missingModels = (models: string[], known: Map<string, unknown>) =>
  [...new Set(models.filter((m) => !known.has(m)))].map((m) => `${m} is not in the catalogue. Check the number on the case back.`);

const placeName = (p: Place | "WAITING") => PLACE_LABEL[p];

/* -------------------------------------------------------------------- moves */

export async function saveMoves(userId: string, moves: Move[], source: string, options: { onlyIntoEmpty?: boolean } = {}): Promise<SaveResult> {
  if (moves.length === 0) return fail(["Nothing to save: every row is blank."]);
  return prisma.$transaction(async (tx) => {
    await lockStock(tx);
    const products = await productsFor(tx, moves.map((m) => m.model));
    const missing = missingModels(moves.map((m) => m.model), products);
    if (missing.length > 0) return fail(missing);
    const balances = await balancesFor(tx, [...products.values()].map((p) => p.id));
    const problems: string[] = [];
    for (const m of moves) {
      const b = balances.get(products.get(m.model)!.id) ?? zero();
      // A prompt's samples: only onto an empty table, so two people saying yes at once pull one each, not two.
      if (options.onlyIntoEmpty && b[m.to] > 0) problems.push(`${m.model}: ${placeName(m.to)} already has one.`);
      else if (b[m.from] < m.qty) problems.push(`${m.model}: only ${b[m.from]} in ${placeName(m.from)}, not ${m.qty}. Check the place, or count it first.`);
      else {
        b[m.from] -= m.qty;
        b[m.to] += m.qty;
        balances.set(products.get(m.model)!.id, b);
      }
    }
    if (problems.length > 0) return fail(problems);

    const entry = await tx.stockEntry.create({
      data: { kind: "MOVES", source, byId: userId, summary: `${moves.length} move(s): ${moves.map((m) => `${m.qty} × ${m.model} ${placeName(m.from)} → ${placeName(m.to)}`).join("; ")}`.slice(0, 2000) },
    });
    await tx.stockMove.createMany({
      data: moves.flatMap((m) => {
        const productId = products.get(m.model)!.id;
        const note = [m.reason, m.note].filter(Boolean).join(" · ");
        return [
          { productId, place: m.from, qty: -m.qty, kind: "MOVE" as const, reason: m.reason, note, entryId: entry.id, byId: userId },
          { productId, place: m.to, qty: m.qty, kind: "MOVE" as const, reason: m.reason, note, entryId: entry.id, byId: userId },
        ];
      }),
    });
    await tx.auditLog.create({ data: { entityType: "StockEntry", entityId: entry.id, action: "STOCK_MOVES", actorId: userId, summary: `${entry.summary} (${source}).`.slice(0, 2000) } });
    return { ok: true, saved: moves.length, problems: [], done: moves.map((m) => `${m.qty} × ${m.model}: ${placeName(m.from)} → ${placeName(m.to)} (${m.reason}).`) };
  }, TX);
}

/* -------------------------------------------------------------- adjustments */

export async function saveAdjustments(userId: string, adjustments: Adjustment[], source: string): Promise<SaveResult> {
  if (adjustments.length === 0) return fail(["Nothing to save: every row is blank."]);
  return prisma.$transaction(async (tx) => {
    await lockStock(tx);
    const products = await productsFor(tx, adjustments.map((a) => a.model));
    const missing = missingModels(adjustments.map((a) => a.model), products);
    if (missing.length > 0) return fail(missing);
    const balances = await balancesFor(tx, [...products.values()].map((p) => p.id));
    const problems: string[] = [];
    // What is added counts before what is taken away, whatever the row order.
    for (const a of adjustments) {
      if (a.qty <= 0) continue;
      const b = balances.get(products.get(a.model)!.id) ?? zero();
      b[a.place] += a.qty;
      balances.set(products.get(a.model)!.id, b);
    }
    // Then pieces going to Damaged, so one written off in the same save is there to write off.
    const subtracts = adjustments.filter((a) => a.qty < 0).sort((a, b) => Number(b.reason === "Damaged") - Number(a.reason === "Damaged"));
    for (const a of subtracts) {
      const b = balances.get(products.get(a.model)!.id) ?? zero();
      if (b[a.place] < -a.qty) problems.push(`${a.model}: only ${b[a.place]} in ${placeName(a.place)}, cannot take away ${-a.qty}. Check the place, or count it first.`);
      else {
        b[a.place] += a.qty;
        if (a.reason === "Damaged") b.DAMAGED -= a.qty;
        balances.set(products.get(a.model)!.id, b);
      }
    }
    if (problems.length > 0) return fail(problems);

    const entry = await tx.stockEntry.create({
      data: {
        kind: "ADJUSTMENTS", source, byId: userId,
        summary: `${adjustments.length} adjustment(s): ${adjustments.map((a) => `${a.qty > 0 ? "+" : ""}${a.qty} ${a.model} ${placeName(a.place)} (${a.reason})`).join("; ")}`.slice(0, 2000),
      },
    });
    await tx.stockMove.createMany({
      data: adjustments.flatMap((a) => {
        const p = products.get(a.model)!;
        const note = [a.reason, a.note].filter(Boolean).join(" · ");
        const base = { productId: p.id, kind: "ADJUST" as const, reason: a.reason, note, entryId: entry.id, byId: userId, unitCostCents: p.costCents };
        // Damaged is not gone: it moves to Damaged, valued at cost until it is credited or written off.
        if (a.reason === "Damaged") {
          return [
            { ...base, place: a.place, qty: a.qty },
            { ...base, place: "DAMAGED" as const, qty: -a.qty },
          ];
        }
        return [{ ...base, place: a.place, qty: a.qty }];
      }),
    });
    await tx.auditLog.create({ data: { entityType: "StockEntry", entityId: entry.id, action: "STOCK_ADJUSTMENTS", actorId: userId, summary: `${entry.summary} (${source}).`.slice(0, 2000) } });
    return {
      ok: true,
      saved: adjustments.length,
      problems: [],
      done: adjustments.map((a) =>
        a.reason === "Damaged"
          ? `${-a.qty} × ${a.model}: ${placeName(a.place)} → Damaged.`
          : `${a.qty > 0 ? "Added" : "Took away"} ${Math.abs(a.qty)} × ${a.model} in ${placeName(a.place)} (${a.reason}).`,
      ),
    };
  }, TX);
}

/* ---------------------------------------------------------------- returns */

/**
 * Returns and cancellations, once the watch is in Gladys's hand.
 *
 * "Back in stock" with an order number finds the sale: still waiting to ship,
 * it is a cancellation and comes back out of "waiting"; already sent, it is a
 * return and comes back at the cost it left with. A sale already put back is
 * not put back twice. With no sale found (sold before launch, no order given)
 * it comes back at the model's cost, and says so.
 */
export async function saveReturns(userId: string, rows: ReturnRow[], source: string): Promise<SaveResult> {
  if (rows.length === 0) return fail(["Nothing to save: every row is blank."]);
  const start = await getStartDate();
  return prisma.$transaction(async (tx) => {
    await lockStock(tx);
    const products = await productsFor(tx, rows.map((r) => r.model));
    const missing = missingModels(rows.map((r) => r.model), products);
    if (missing.length > 0) return fail(missing);
    const balances = await balancesFor(tx, [...products.values()].map((p) => p.id));

    type Line = { productId: string; place: Place | "WAITING"; qty: number; saleId?: string; unitCostCents: number | null; note: string; reason: string };
    const lines: Line[] = [];
    const saleChanges: { id: string; status: "CANCELLED" | "RETURNED" }[] = [];
    const taken = new Set<string>();
    const problems: string[] = [];
    const done: string[] = [];

    // Watches coming back count before watches going out, so a swap (the
    // customer's back, a replacement out) works with the shelf at zero.
    const ordered = [...rows].sort((a, b) => Number(a.type !== "Back in stock") - Number(b.type !== "Back in stock"));
    for (const r of ordered) {
      const p = products.get(r.model)!;
      const note = [r.type, r.order ? `order ${r.order}` : "", r.note].filter(Boolean).join(" · ");
      if (r.type === "Refund only") {
        done.push(`${r.model}: refund only — no watch moved.`);
        continue;
      }
      if (r.type === "Exchange / reship") {
        const b = balances.get(p.id) ?? zero();
        // Not from random pulls: a returned, scratched watch just put there is not a replacement.
        const from = (["SELLABLE", "SAMPLE_EBAY", "SAMPLE_TIKTOK"] as const).find((pl) => b[pl] >= r.qty);
        if (!from) {
          problems.push(`${r.model}: no ${r.qty} left anywhere to send. Check the shelf, or count it.`);
          continue;
        }
        b[from] -= r.qty;
        balances.set(p.id, b);
        lines.push({ productId: p.id, place: from, qty: -r.qty, unitCostCents: p.costCents, note, reason: r.type });
        done.push(`${r.qty} × ${r.model} sent out of ${placeName(from)} (exchange / reship).`);
        continue;
      }
      // Back in stock, one watch at a time, each tied to its sale where there is one.
      const sales = r.order
        ? await tx.stockSale.findMany({
            where: { orderRef: r.order, product: { model: r.model } },
            orderBy: [{ status: "asc" }, { key: "asc" }],
            select: { id: true, status: true, costCents: true },
          })
        : [];
      let unmatched = "";
      if (r.order && sales.length === 0) {
        // No sale of this watch on that order. A number in no report at all is a
        // typo (or the eBay order number instead of its sales record number):
        // refused, so a waiting watch never ends up counted twice.
        const inReports = await tx.salesRecord.findFirst({ where: { orderRef: r.order, business: "WATCH" }, orderBy: { showDate: "desc" }, select: { showDate: true } });
        const otherSale = await tx.stockSale.findFirst({ where: { orderRef: r.order }, select: { status: true, product: { select: { model: true } } } });
        if (otherSale && (otherSale.status === "SOLD" || otherSale.status === "CANCELLED" || otherSale.status === "UNDONE")) {
          // Nothing of that order went out: this is a typo in the model, not a different watch back.
          problems.push(
            `${r.model}: order ${r.order} ${otherSale.status === "SOLD" ? "is waiting to ship" : "was"} ${otherSale.product.model}, not ${r.model}, and never went out. Check the model number on the watch.`,
          );
          continue;
        }
        if (!otherSale && inReports && start && inReports.showDate.toISOString().slice(0, 10) >= start) {
          // In a report since launch, but not taken off stock yet (uploaded a moment ago, or stock could not be
          // brought up to date): booked now, it would count twice once it is.
          problems.push(`${r.model}: order ${r.order} has not come off stock yet. Try again in a minute; if it keeps saying this, see Inventory → Sales.`);
          continue;
        }
        if (!inReports && !otherSale) {
          problems.push(
            `${r.model}: order ${r.order} is in no report. Check the number — the TikTok order ID, or the eBay sales record number (not the eBay order number). ` +
              `If the watch was sold before StreamOps had its reports, leave Order # blank.`,
          );
          continue;
        }
        unmatched = otherSale
          ? `order ${r.order} was for ${otherSale.product.model}: a different watch came back`
          : `order ${r.order} sold before launch`;
      }
      const open = sales.filter((s) => (s.status === "SOLD" || s.status === "SENT") && !taken.has(s.id));
      if (r.order && sales.length > 0 && open.length < r.qty) {
        problems.push(
          `${r.model}, order ${r.order}: ${open.length === 0 ? "already put back" : `only ${open.length} of it can come back`} — ` +
            `the order had ${sales.length}, and the rest were already returned or cancelled.`,
        );
        continue;
      }
      for (let i = 0; i < r.qty; i++) {
        const s = open[i];
        if (s) {
          taken.add(s.id);
          if (s.status === "SOLD") {
            // Never shipped: out of "waiting", back where Gladys put it.
            lines.push({ productId: p.id, place: "WAITING", qty: -1, saleId: s.id, unitCostCents: s.costCents, note, reason: "Cancelled" });
            lines.push({ productId: p.id, place: r.to!, qty: 1, saleId: s.id, unitCostCents: s.costCents, note, reason: "Cancelled" });
            saleChanges.push({ id: s.id, status: "CANCELLED" });
          } else {
            lines.push({ productId: p.id, place: r.to!, qty: 1, saleId: s.id, unitCostCents: s.costCents, note, reason: "Returned" });
            saleChanges.push({ id: s.id, status: "RETURNED" });
          }
        } else {
          lines.push({ productId: p.id, place: r.to!, qty: 1, unitCostCents: p.costCents, note: `${note} · ${unmatched || "no order given"}`, reason: "Returned" });
        }
      }
      const back = balances.get(p.id) ?? zero();
      back[r.to!] += r.qty;
      balances.set(p.id, back);
      const kinds = open.slice(0, r.qty).map((s) => (s.status === "SOLD" ? "cancelled before shipping" : "returned"));
      done.push(
        `${r.qty} × ${r.model} back in ${placeName(r.to!)}` +
          (kinds.length > 0 ? ` (${[...new Set(kinds)].join(", ")})` : ` (${unmatched || "no order given"})`) +
          ".",
      );
    }
    if (problems.length > 0) return fail(problems);

    const entry = await tx.stockEntry.create({
      data: { kind: "RETURNS", source, byId: userId, summary: `${rows.length} return/cancellation row(s): ${done.join(" ")}`.slice(0, 2000) },
    });
    if (lines.length > 0) {
      await tx.stockMove.createMany({
        data: lines.map((l) => ({ ...l, kind: "RETURN" as const, entryId: entry.id, byId: userId })),
      });
    }
    // Settled by hand: any "check with the buyer" flag on it is answered.
    for (const c of saleChanges) await tx.stockSale.update({ where: { id: c.id }, data: { status: c.status, flag: "" } });
    await tx.auditLog.create({ data: { entityType: "StockEntry", entityId: entry.id, action: "STOCK_RETURNS", actorId: userId, summary: `${entry.summary} (${source}).`.slice(0, 2000) } });
    return { ok: true, saved: rows.length, problems: [], done };
  }, TX);
}

/* ------------------------------------------------------------------- undo */

/**
 * Undo one save: every stock line it wrote, reversed, and any sale it
 * cancelled or returned set back. Refused once undone, or if a sale it touched
 * has changed since.
 */
export async function undoEntry(userId: string, entryId: string): Promise<{ ok: boolean; problem?: string }> {
  return prisma.$transaction(async (tx) => {
    await lockStock(tx);
    const entry = await tx.stockEntry.findUnique({ where: { id: entryId } });
    if (!entry) return { ok: false, problem: "That save is not there any more. Refresh the page." };
    if (entry.undoneAt) return { ok: false, problem: "Already undone." };
    const moves = await tx.stockMove.findMany({ where: { entryId } });
    const saleIds = [...new Set(moves.flatMap((m) => (m.saleId ? [m.saleId] : [])))];
    const sales = await tx.stockSale.findMany({ where: { id: { in: saleIds } }, select: { id: true, status: true } });
    const changed = sales.filter((s) => s.status !== "CANCELLED" && s.status !== "RETURNED");
    if (changed.length > 0) return { ok: false, problem: "A sale in it has changed since. Put it right with a new entry instead." };
    // Never below zero: if what it put somewhere has since sold or moved on,
    // undoing it would take away pieces that are no longer there.
    const balances = await balancesFor(tx, [...new Set(moves.map((m) => m.productId))]);
    const net = new Map<string, number>();
    for (const m of moves) {
      const b = balances.get(m.productId) ?? zero();
      b[m.place] -= m.qty;
      balances.set(m.productId, b);
      net.set(`${m.productId}|${m.place}`, (net.get(`${m.productId}|${m.place}`) ?? 0) - m.qty);
    }
    // Only a place the undo takes away from, and would leave below zero. (One already below zero
    // because more sold than there was is not made worse by an undo that adds to it.)
    const short = [...balances.entries()].flatMap(([id, b]) =>
      ([...PLACES, "WAITING"] as const).filter((pl) => b[pl] < 0 && (net.get(`${id}|${pl}`) ?? 0) < 0).map((pl) => ({ id, pl })),
    );
    if (short.length > 0) {
      const names = await tx.product.findMany({ where: { id: { in: short.map((s) => s.id) } }, select: { id: true, model: true } });
      const model = new Map(names.map((n) => [n.id, n.model]));
      return {
        ok: false,
        problem: `It cannot be undone: ${short.map((s) => `${model.get(s.id)} in ${placeName(s.pl)}`).join(", ")} would go below zero — those pieces have moved on since. Put it right with a new entry instead.`,
      };
    }
    await tx.stockMove.createMany({
      data: moves.map((m) => ({
        productId: m.productId, place: m.place, qty: -m.qty, kind: m.kind, reason: m.reason, unitCostCents: m.unitCostCents,
        saleId: m.saleId, note: `Undone: ${m.note}`.slice(0, 500), entryId: `undo-${entryId}`, byId: userId,
      })),
    });
    // A cancelled sale goes back to waiting; a returned one back to sent.
    for (const s of sales) await tx.stockSale.update({ where: { id: s.id }, data: { status: s.status === "CANCELLED" ? "SOLD" : "SENT", flag: "" } });
    await tx.stockEntry.update({ where: { id: entryId }, data: { undoneAt: new Date(), undoneById: userId } });
    await tx.auditLog.create({ data: { entityType: "StockEntry", entityId: entryId, action: "STOCK_ENTRY_UNDONE", actorId: userId, summary: `Undid: ${entry.summary}`.slice(0, 2000) } });
    return { ok: true };
  }, TX);
}

/* ------------------------------------------------------------------ reading */

export async function recentEntries(limit = 20) {
  return prisma.stockEntry.findMany({
    orderBy: { at: "desc" },
    take: limit,
    select: { id: true, kind: true, source: true, summary: true, at: true, undoneAt: true, by: { select: { name: true } }, undoneBy: { select: { name: true } } },
  });
}

/** What to ask Gladys: samples for new models, and samples to random pulls when the shelf runs out. */
export async function getPrompts(): Promise<(Prompt & { picture: string; description: string })[]> {
  const since = new Date(Date.now() - 86_400_000);
  const [products, balances, firsts, shelfSales, snoozed] = await Promise.all([
    prisma.product.findMany({ where: { active: true }, select: { id: true, model: true, description: true } }),
    balancesFor(prisma),
    prisma.stockMove.groupBy({ by: ["productId"], where: { kind: "RECEIVED", qty: { gt: 0 } }, _min: { at: true } }),
    prisma.stockMove.groupBy({ by: ["productId"], where: { kind: "SOLD", place: "SELLABLE", qty: { lt: 0 } }, _max: { at: true } }),
    prisma.auditLog.findMany({ where: { action: "PROMPT_NOT_YET", createdAt: { gte: since } }, select: { entityId: true } }),
  ]);
  const first = new Map(firsts.map((f) => [f.productId, f._min.at]));
  const lastSale = new Map(shelfSales.map((f) => [f.productId, f._max.at]));
  const hidden = new Set(snoozed.map((s) => s.entityId));
  const list = prompts(
    products.map((p) => {
      const b = balances.get(p.id) ?? zero();
      return {
        model: p.model,
        balances: Object.fromEntries(PLACES.map((pl) => [pl, b[pl]])) as Record<Place, number>,
        firstReceived: first.get(p.id) ?? null,
        lastShelfSale: lastSale.get(p.id) ?? null,
      };
    }),
    new Date(),
  ).filter((x) => !hidden.has(`${x.model}|${x.kind}`));
  const pictures = await picturesFor(list.map((x) => x.model));
  const desc = new Map(products.map((p) => [p.model, p.description]));
  return list.map((x) => ({ ...x, picture: pictures.get(x.model) ?? "", description: desc.get(x.model) ?? "" }));
}

/** "Not yet": the prompt is not shown again for a day. */
export async function snoozePrompt(userId: string, model: string, kind: string): Promise<void> {
  await prisma.auditLog.create({
    data: { entityType: "Prompt", entityId: `${model}|${kind}`, action: "PROMPT_NOT_YET", actorId: userId, summary: `Not yet: ${kind} for ${model}.` },
  });
}

/* -------------------------------------------------------------- templates */

const TEMPLATES: Record<Kind, { name: string; columns: readonly string[]; help: string; lists: [string, readonly string[]][] }> = {
  MOVES: {
    name: "Moves between places",
    columns: MOVE_COLUMNS,
    help: "Moves pieces between places; the total does not change. One row per model.",
    lists: [["From / To", PLACES.map((p) => PLACE_LABEL[p])], ["Reason", MOVE_REASONS]],
  },
  ADJUSTMENTS: {
    name: "Adjustments",
    columns: ADJUST_COLUMNS,
    help: "Adds or takes away, with a reason from the list. Damaged moves the pieces to Damaged.",
    lists: [["Action", ["Add", "Subtract"]], ["Place", PLACES.map((p) => PLACE_LABEL[p])], ["Reason", ADJUST_REASONS]],
  },
  RETURNS: {
    name: "Returns and cancellations",
    columns: RETURN_COLUMNS,
    help: "Only once the watch is in Gladys's hand. Back in stock needs Goes to; give the order number so it is tied to its sale.",
    lists: [["Type", RETURN_TYPES], ["Goes to", RETURN_PLACES]],
  },
};

/** A blank template, with the allowed words listed beneath it. */
export async function templateSheet(kind: Kind): Promise<ArrayBuffer> {
  const t = TEMPLATES[kind];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t.name.slice(0, 31), { views: [{ state: "frozen", ySplit: 2 }] });
  ws.getCell("A1").value = t.help;
  ws.getCell("A1").font = { italic: true, color: { argb: "FF5B6472" } };
  ws.getRow(2).values = [...t.columns];
  ws.getRow(2).font = { bold: true };
  ws.columns = t.columns.map((c) => ({ width: c.includes("note") || c === "Note" ? 40 : 16 }));
  // Model numbers and order numbers as text: an 18-digit TikTok order id typed
  // into a number cell loses its last digits.
  ws.getColumn(1).numFmt = "@";
  const orderCol = t.columns.indexOf("Order #");
  if (orderCol >= 0) ws.getColumn(orderCol + 1).numFmt = "@";
  const lists = wb.addWorksheet("Allowed words");
  lists.getRow(1).values = ["Column", "Allowed"];
  lists.getRow(1).font = { bold: true };
  for (const [col, words] of t.lists) lists.addRow([col, words.join(", ")]);
  lists.columns = [{ width: 14 }, { width: 120 }];
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** A filled-in template, checked to be the right one by its columns. */
export async function readTemplate(kind: Kind, buffer: ArrayBuffer): Promise<{ rows: { line: number; row: Row }[]; problem?: string }> {
  let sheets;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    sheets = sheetRows(wb, (c) => /^model\s*#?$/i.test(c.trim()));
  } catch {
    return { rows: [], problem: "That is not an Excel (.xlsx) file. Download the template and fill that in." };
  }
  const sheet = sheets.find((s) => s.rows.length > 0) ?? sheets[0];
  if (!sheet) return { rows: [], problem: 'No sheet has a "Model #" column. Is this the right template?' };
  const headings = new Set(sheet.rows.flatMap((r) => Object.keys(r.values)).map((h) => h.trim().toLowerCase()));
  const looksLike = (Object.keys(TEMPLATES) as Kind[]).find((k) => TEMPLATES[k].columns.every((c) => headings.has(c.toLowerCase())));
  if (looksLike && looksLike !== kind) {
    return { rows: [], problem: `This looks like the ${TEMPLATES[looksLike].name.toLowerCase()} template. Upload it in that box instead.` };
  }
  const missing = TEMPLATES[kind].columns.filter((c) => c !== "Note" && c !== "Condition / note" && c !== "Order #" && !headings.has(c.toLowerCase()));
  if (sheet.rows.length > 0 && missing.length > 0) return { rows: [], problem: `The sheet has no ${missing.map((m) => `"${m}"`).join(", ")} column. Use the template as downloaded.` };
  return { rows: sheet.rows.map((r) => ({ line: r.line, row: r.values as Row })) };
}

export { readAdjustment, readMove, readReturn };

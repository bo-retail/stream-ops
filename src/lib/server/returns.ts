import "server-only";
import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { catalogueSpelling } from "@/lib/domain/inventory";
import type { DateISO } from "@/lib/domain/types";
import { todayISO } from "@/lib/domain/dates";
import { balancesFor, countedAfter, zero } from "./inventory";
import { getSettings } from "./settings";
import type { ReceivedEntry } from "./receive";

/**
 * Returns, kept simple (Samuel, 10/15): watches that came back are counted and
 * uploaded on the same Model / Quantity sheet as a delivery, and all of them go
 * back to Sellable. Only what can be sold again is entered; a damaged return is
 * simply not put back. No order number: the sale itself is not touched.
 *
 * A sale is never put back on its own once its box has shipped (deduction only
 * flags it), so a returned watch is counted here exactly once. An order
 * cancelled *before* it shipped is put back by the corrected sales report, and
 * is not entered here.
 *
 * Stored as RETURN moves to Sellable, reason "return <fingerprint>", note
 * "Returned <day> — <name>". Older returns made on the hidden Movements page
 * have reasons "Returned" / "Cancelled" and are not part of this log.
 */

/** More of one model than this in one upload is asked about before it is added. */
export const LARGE_RETURN = 20;

export interface ReturnResult {
  ok: boolean;
  problems: string[];
  models: number;
  pieces: number;
}

/** The same returns that day: the models, quantities and day — not the file's bytes. */
function fingerprint(entries: ReceivedEntry[], returnedOn: DateISO): string {
  const lines = entries.map((e) => `${e.model}|${e.qty}`).sort();
  return createHash("sha256").update([returnedOn, ...lines].join("\n")).digest("hex");
}

/** Adds returned watches back to Sellable. Nothing is added if any model is not in inventory. */
export async function saveReturn(
  userId: string,
  entries: ReceivedEntry[],
  returnedOn: DateISO,
  fileName: string,
  /** "Yes, add it anyway": the same returns again that day really are other watches, or the large quantities are right. */
  confirmed = false,
  /** What it is called in the log; the file's name when left blank. */
  name = "",
): Promise<ReturnResult> {
  const fail = (problems: string[]): ReturnResult => ({ ok: false, problems, models: 0, pieces: 0 });
  const entryId = randomUUID();
  const { timezone } = await getSettings();

  return prisma.$transaction(
    async (tx) => {
      // The stock lock: nothing else moves stock meanwhile, and two uploads of one sheet cannot both pass the check below.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;

      const products = await tx.product.findMany({ select: { id: true, model: true } });
      const idOf = new Map(products.map((p) => [p.model, p.id]));

      const spell = catalogueSpelling(idOf.keys());
      const merged = new Map<string, ReceivedEntry>();
      for (const e of entries) {
        const model = spell(e.model);
        const seen = merged.get(model);
        if (seen) seen.qty += e.qty;
        else merged.set(model, { ...e, model });
      }
      const returning = [...merged.values()].filter((e) => e.qty > 0);
      if (returning.length === 0) return fail(["Nothing to add: every quantity is blank or 0."]);

      // A return is a watch we sold, so its model is already here; one that is not is a typo.
      const unknown = returning.filter((e) => !idOf.has(e.model));
      if (unknown.length > 0) {
        return fail(
          unknown.map((e) => `${e.where}: "${e.model}" is not in inventory. Check the model number on the watch.`),
        );
      }

      /*
        Asked about first, unless "add it anyway" is ticked:
        - returns for that same day already added with any of these models: the
          sheet uploaded twice, or a corrected sheet put in without undoing the
          first, which would add both;
        - the very same sheet under another date in the last two hours: the
          date corrected and uploaded again without undoing;
        - a count of these models on or after the day they came back: if they
          were on the shelf then, the count has them already;
        - quantities too large to be returns.
        One watch of a model coming back on another day is ordinary and not asked about.
      */
      const print = fingerprint(returning, returnedOn);
      const reason = `return ${print}`;
      if (!confirmed) {
        // Every question at once: the one tick answers all that were shown, never one that was not.
        const asks: string[] = [];
        const ids = returning.map((e) => idOf.get(e.model)!);
        const sameDay = await tx.stockMove.findFirst({
          where: { kind: "RETURN", reason: { startsWith: "return " }, note: { startsWith: `Returned ${returnedOn} ` }, productId: { in: ids } },
          select: { note: true },
        });
        if (sameDay) {
          asks.push(
            `Returns for that day with some of these models are already added (${sameDay.note}). ` +
              `If that upload had wrong numbers, undo it below first, then upload the corrected sheet.`,
          );
        }
        const redated = (
          await tx.stockMove.findMany({
            where: { kind: "RETURN", reason: { startsWith: "return " }, at: { gte: new Date(Date.now() - 2 * 3_600_000) } },
            select: { entryId: true, note: true, qty: true, product: { select: { model: true } } },
          })
        ).reduce((m, x) => m.set(x.entryId, [...(m.get(x.entryId) ?? []), x]), new Map<string, { note: string; qty: number; product: { model: string } }[]>());
        const sameSheet = [...redated.values()].find(
          (lines) => fingerprint(lines.map((l) => ({ model: l.product.model, qty: l.qty, where: "", description: "" })), returnedOn) === print,
        );
        if (sameSheet) {
          asks.push(
            `The same returns were just added under another day (${sameSheet[0].note}). ` +
              `If the day was wrong, undo that one below first, then upload again.`,
          );
        }
        const counted = await countedAfter(tx, ids, null);
        if (counted && todayISO(timezone, counted) >= returnedOn) {
          asks.push(
            `These models were counted on ${todayISO(timezone, counted)}, on or after the day these came back. ` +
              `If they were already on the shelf when it was counted, the count has them: do not add them.`,
          );
        }
        const large = returning.filter((e) => e.qty > LARGE_RETURN);
        if (large.length > 0) {
          asks.push(
            `Large quantities for returns: ${large.map((e) => `${e.model} × ${e.qty}`).join(", ")}. ` +
              `A new delivery goes on Receive inventory, not here.`,
          );
        }
        if (asks.length > 0) {
          return fail([
            ...asks,
            `Nothing was added. Only if every point above is fine — these really are other watches that came back after any count — tick "Yes, add it anyway" and upload again.`,
          ]);
        }
      }

      const label = name.trim().replace(/\s+/g, " ").slice(0, 80) || fileName;
      const note = `Returned ${returnedOn} — ${label}`;
      const lines = returning.map((e) => ({
        productId: idOf.get(e.model)!,
        place: "SELLABLE" as const,
        qty: e.qty,
        kind: "RETURN" as const,
        reason,
        note,
        entryId,
        byId: userId,
      }));
      await tx.stockMove.createMany({ data: lines });
      await tx.product.updateMany({ where: { id: { in: lines.map((l) => l.productId) }, active: false }, data: { active: true } });

      const pieces = lines.reduce((n, l) => n + l.qty, 0);
      await tx.auditLog.create({
        data: {
          entityType: "StockMove",
          entityId: entryId,
          action: "RETURNED",
          actorId: userId,
          summary: `Returned ${returnedOn} (${fileName}): ${returning.length} model(s), ${pieces} piece(s) back to Sellable`,
        },
      });
      return { ok: true, problems: [], models: returning.length, pieces };
    },
    { timeout: 60_000, maxWait: 30_000 },
  );
}

/** The returns sheet: Model and Quantity, one row per model that came back. */
export async function returnsSheet(today: string): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Returned", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.getCell("A1").value =
    `Returns — one row per model, and how many came back that can be sold again. They all go to Sellable. ` +
    `Upload it once on Inventory → Returns (downloaded ${today}).`;
  ws.getCell("A1").font = { italic: true, color: { argb: "FF5B6472" } };
  ws.getRow(2).values = ["Model", "Quantity"];
  ws.getRow(2).font = { bold: true };
  ws.columns = [{ width: 18 }, { width: 12 }];
  // Model numbers as text, so Excel never drops a leading zero.
  ws.getColumn(1).numFmt = "@";
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

export interface ReturnBatch {
  entryId: string;
  note: string;
  name: string;
  returnedOn: DateISO;
  /** When it was uploaded. */
  at: Date;
  by: string;
  undone: boolean;
  pieces: number;
  items: { model: string; qty: number }[];
}

/** Every returns upload, newest first. One undone stays in the log, marked. */
export async function returnLog(limit = 200): Promise<ReturnBatch[]> {
  const moves = await prisma.stockMove.findMany({
    where: { kind: "RETURN", OR: [{ reason: { startsWith: "return " } }, { reason: { startsWith: "undone return " } }] },
    orderBy: { at: "desc" },
    take: 20_000,
    select: { entryId: true, qty: true, note: true, at: true, reason: true, product: { select: { model: true } }, by: { select: { name: true } } },
  });
  const byEntry = new Map<string, ReturnBatch & { byModel: Map<string, number> }>();
  for (const m of moves) {
    let r = byEntry.get(m.entryId);
    if (!r) {
      if (byEntry.size >= limit) continue;
      const cut = m.note.indexOf(" — ");
      r = {
        entryId: m.entryId,
        note: m.note,
        name: cut >= 0 ? m.note.slice(cut + 3) : m.note,
        returnedOn: m.note.slice("Returned ".length, "Returned ".length + 10) as DateISO,
        at: m.at,
        by: m.by?.name ?? "",
        undone: m.reason.startsWith("undone "),
        pieces: 0,
        items: [],
        byModel: new Map(),
      };
      byEntry.set(m.entryId, r);
    }
    r.pieces += m.qty;
    r.byModel.set(m.product.model, (r.byModel.get(m.product.model) ?? 0) + m.qty);
  }
  return [...byEntry.values()].map(({ byModel, ...r }) => ({
    ...r,
    items: [...byModel].map(([model, qty]) => ({ model, qty })).sort((a, b) => a.model.localeCompare(b.model)),
  }));
}

/** Takes a returns upload back off Sellable: one added with wrong numbers. The corrected sheet can go in after. */
export async function undoReturn(userId: string, entryId: string): Promise<{ ok: boolean; message: string }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;
      const moves = await tx.stockMove.findMany({
        where: { entryId, kind: "RETURN", reason: { startsWith: "return " } },
        select: { productId: true, qty: true, note: true, reason: true, at: true, product: { select: { model: true } } },
      });
      if (moves.length === 0) return { ok: false, message: "Those returns were already undone, or are not there." };
      const productIds = [...new Set(moves.map((m) => m.productId))];

      // Counted since: the count already holds what is on the shelf, these returns included.
      if (await countedAfter(tx, productIds, moves[0].at)) {
        return { ok: false, message: "These watches were counted after the returns were added, so the count already has them. Nothing was undone." };
      }

      // Sellable can go below zero, as it does when more sold than was counted; that is said.
      const now = await balancesFor(tx, productIds);
      const below = moves
        .map((m) => ({ model: m.product.model, left: (now.get(m.productId) ?? zero()).SELLABLE - m.qty }))
        .filter((x) => x.left < 0)
        .map((x) => `${x.model} Sellable ${x.left}`);
      const undoId = randomUUID();
      await tx.stockMove.createMany({
        data: moves.map((m) => ({
          productId: m.productId,
          place: "SELLABLE" as const,
          qty: -m.qty,
          kind: "RETURN" as const,
          reason: `undo ${entryId}`,
          note: `Undone: ${m.note}`,
          entryId: undoId,
          byId: userId,
        })),
      });
      // No longer returns that were added: not "already added", marked Undone in the log.
      await tx.stockMove.updateMany({ where: { entryId, kind: "RETURN" }, data: { reason: `undone ${moves[0].reason}` } });
      const pieces = moves.reduce((n, m) => n + m.qty, 0);
      await tx.auditLog.create({
        data: {
          entityType: "StockMove",
          entityId: entryId,
          action: "RETURNED_UNDONE",
          actorId: userId,
          summary: `Undid ${moves[0].note}: ${pieces} piece(s) taken back off Sellable`,
        },
      });
      return {
        ok: true,
        message:
          `Undone: ${moves[0].note.replace(/^Returned /, "")}. ${pieces} piece(s) taken back off Sellable.` +
          (below.length > 0 ? ` Some had sold since, so these are now below zero: ${below.join(", ")}.` : ""),
      };
    },
    { timeout: 60_000, maxWait: 30_000 },
  );
}

/** Every return between two dates (by the day it came back) — for the Excel download. */
export async function returnsBetween(from: DateISO, to: DateISO) {
  const moves = await prisma.stockMove.findMany({
    where: { kind: "RETURN", reason: { startsWith: "return " } },
    orderBy: { at: "desc" },
    select: { qty: true, note: true, product: { select: { model: true } } },
  });
  return moves
    .map((m) => ({ ...m, returnedOn: m.note.slice("Returned ".length, "Returned ".length + 10) as DateISO }))
    .filter((m) => m.returnedOn >= from && m.returnedOn <= to);
}

import "server-only";
import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { COUNTED_LABEL, COUNTED_PLACES, badModelNumber, catalogueSpelling, placeReceived } from "@/lib/domain/inventory";
import type { CountedPlace } from "@/lib/domain/inventory";
import type { DateISO } from "@/lib/domain/types";
import { todayISO } from "@/lib/domain/dates";
import { balancesFor, countedAfter, zero } from "./inventory";
import { getSettings } from "./settings";
import type { ReceivedEntry } from "./receive";

/**
 * Returns, kept simple (Samuel, 10/15): watches that came back are counted and
 * uploaded on the same Model / Quantity sheet as a delivery. A model already in
 * inventory is placed by the shipment rules (`placeReceived`: a missing sample
 * filled first, 1 or 2 of a model missing samples to Random pulls, the rest
 * Sellable). A model never in inventory goes where the person uploading says —
 * the page asks before anything is added. Only what can be sold again is
 * entered; a damaged return is simply not put back. No order number: the sale
 * itself is not touched.
 *
 * A sale is never put back on its own once its box has shipped (deduction only
 * flags it), so a returned watch is counted here exactly once. An order
 * cancelled *before* it shipped is put back by the corrected sales report, and
 * is not entered here.
 *
 * Stored as RETURN moves, reason "return <fingerprint>", note
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
  /** Models not on the list before, added by this upload: named so a typo is seen. */
  added: string[];
  /** How many went to each place. */
  placed: Record<CountedPlace, number>;
  /** Models never in inventory with no place chosen yet: the page asks where each goes, and nothing is added. */
  needsPlace: { model: string; qty: number }[];
}

const none = (): Record<CountedPlace, number> => ({ SELLABLE: 0, SAMPLE_TIKTOK: 0, SAMPLE_EBAY: 0, RANDOM_PULLS: 0 });
const isPlace = (p: string | undefined): p is CountedPlace => (COUNTED_PLACES as readonly string[]).includes(p ?? "");
const bare = (m: string) => m.replace(/^0+(?=\d)/, "");

/** The same returns that day: the models, quantities and day — not the file's bytes. */
function fingerprint(entries: ReceivedEntry[], returnedOn: DateISO): string {
  const lines = entries.map((e) => `${e.model}|${e.qty}`).sort();
  return createHash("sha256").update([returnedOn, ...lines].join("\n")).digest("hex");
}

/** Adds returned watches back to stock; a model never in inventory goes where `placeFor` says. */
export async function saveReturn(
  userId: string,
  entries: ReceivedEntry[],
  returnedOn: DateISO,
  fileName: string,
  /** "Yes, add it anyway": the same returns again that day really are other watches, or the large quantities are right. */
  confirmed = false,
  /** What it is called in the log; the file's name when left blank. */
  name = "",
  /** For each model never in inventory, by the model number the page was shown: where it goes. */
  placeFor: Record<string, string> = {},
): Promise<ReturnResult> {
  const fail = (problems: string[], needsPlace: ReturnResult["needsPlace"] = []): ReturnResult =>
    ({ ok: false, problems, models: 0, pieces: 0, added: [], placed: none(), needsPlace });
  const entryId = randomUUID();
  const { timezone } = await getSettings();

  return prisma.$transaction(
    async (tx) => {
      // The stock lock: nothing else moves stock meanwhile, and two uploads of one sheet cannot both pass the check below.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;

      const products = await tx.product.findMany({ select: { id: true, model: true } });
      const idOf = new Map(products.map((p) => [p.model, p.id]));

      const spell = catalogueSpelling(idOf.keys());
      // A new number written two ways on one sheet ("99881", "099881") is one model, under its first spelling.
      const firstSpelling = new Map<string, string>();
      const merged = new Map<string, ReceivedEntry>();
      for (const e of entries) {
        let model = spell(e.model);
        if (!idOf.has(model) && /^\d+$/.test(model)) {
          model = firstSpelling.get(bare(model)) ?? model;
          firstSpelling.set(bare(model), model);
        }
        const seen = merged.get(model);
        if (seen) seen.qty += e.qty;
        else merged.set(model, { ...e, model });
      }
      const returning = [...merged.values()].filter((e) => e.qty > 0);
      if (returning.length === 0) return fail(["Nothing to add: every quantity is blank or 0."]);

      /*
        A model at zero, or not on the list at all, can come back (Gladys, 10/15):
        it is added, as on Receive inventory, and named in the result so a typo
        is seen. Only what cannot be a model number at all stops the upload.
      */
      // Two catalogue models that differ only in leading zeros: a number matching both is neither, and not made a third.
      const byDigits = new Map<string, string[]>();
      for (const m of idOf.keys()) if (/^\d+$/.test(m)) byDigits.set(bare(m), [...(byDigits.get(bare(m)) ?? []), m]);
      const unreadable = returning
        .filter((e) => !idOf.has(e.model))
        // A long run of digits is a barcode, or a number Excel rewrote, not a model.
        .map((e) => {
          const both = /^\d+$/.test(e.model) ? (byDigits.get(bare(e.model)) ?? []) : [];
          if (both.length > 1) return { e, bad: `"${e.model}" could be ${both.join(" or ")}. Write the model number exactly as it is in inventory` };
          return { e, bad: /^\d{9,}$/.test(e.model) ? `"${e.model}" is too long to be a model number. Is it a barcode?` : badModelNumber(e.model) };
        })
        .filter((x) => x.bad !== null)
        .map(({ e, bad }) => `${e.where}: ${bad}${/[.?!]$/.test(bad!) ? "" : "."}`);
      if (unreadable.length > 0) return fail(unreadable);

      // Never in inventory: where it goes is asked before anything else, and nothing is added until every one is answered.
      const unplaced = returning.filter((e) => !idOf.has(e.model) && !isPlace(placeFor[e.model]));
      if (unplaced.length > 0) return fail([], unplaced.map((e) => ({ model: e.model, qty: e.qty })));

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
        const ids = returning.flatMap((e) => idOf.get(e.model) ?? []);
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
        // One line per model, however many places its pieces went to.
        const sameSheet = [...redated.values()].find((lines) => {
          const perModel = new Map<string, number>();
          for (const l of lines) perModel.set(l.product.model, (perModel.get(l.product.model) ?? 0) + l.qty);
          return fingerprint([...perModel].map(([model, qty]) => ({ model, qty, where: "", description: "" })), returnedOn) === print;
        });
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

      // Not on the list yet: added here, after the questions, so a refused upload leaves nothing behind.
      const added: string[] = [];
      for (const e of returning) {
        if (idOf.has(e.model)) continue;
        const created = await tx.product.create({
          data: { model: e.model, description: e.description, needsDetails: true, active: true },
          select: { id: true },
        });
        idOf.set(e.model, created.id);
        added.push(e.model);
      }

      const label = name.trim().replace(/\s+/g, " ").slice(0, 80) || fileName;
      const note = `Returned ${returnedOn} — ${label}`;
      // Where each one goes: a new model where it was told; the rest by the shipment rules, from what the model holds now.
      const current = await balancesFor(tx, returning.map((e) => idOf.get(e.model)!));
      const placed = none();
      const lines = returning.flatMap((e) => {
        const productId = idOf.get(e.model)!;
        const now = current.get(productId) ?? zero();
        const chosen = placeFor[e.model];
        const where = added.includes(e.model) && isPlace(chosen)
          ? { ...none(), [chosen]: e.qty }
          : placeReceived(e.qty, { tiktokSample: now.SAMPLE_TIKTOK > 0, ebaySample: now.SAMPLE_EBAY > 0 });
        return COUNTED_PLACES.filter((p) => where[p] > 0).map((place) => {
          placed[place] += where[place];
          return { productId, place, qty: where[place], kind: "RETURN" as const, reason, note, entryId, byId: userId };
        });
      });
      await tx.stockMove.createMany({ data: lines });
      await tx.product.updateMany({ where: { id: { in: lines.map((l) => l.productId) }, active: false }, data: { active: true } });

      const pieces = lines.reduce((n, l) => n + l.qty, 0);
      await tx.auditLog.create({
        data: {
          entityType: "StockMove",
          entityId: entryId,
          action: "RETURNED",
          actorId: userId,
          summary: `Returned ${returnedOn} (${fileName}): ${returning.length} model(s), ${pieces} piece(s) — ` +
            COUNTED_PLACES.map((p) => `${COUNTED_LABEL[p]} ${placed[p]}`).join(", ") +
            (added.length > 0 ? `; ${added.length} new model(s): ${added.join(", ")}` : ""),
          after: { added },
        },
      });
      return { ok: true, problems: [], models: returning.length, pieces, added, placed, needsPlace: [] };
    },
    { timeout: 60_000, maxWait: 30_000 },
  );
}

/** The returns sheet: Model and Quantity, one row per model that came back. */
export async function returnsSheet(today: string): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Returned", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.getCell("A1").value =
    `Returns — one row per model, and how many came back that can be sold again. The app puts them where they belong. ` +
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
  /** Each model in it, and how many went to each place. */
  items: { model: string; placed: Record<CountedPlace, number>; total: number }[];
}

/** Every returns upload, newest first. One undone stays in the log, marked. */
export async function returnLog(limit = 200): Promise<ReturnBatch[]> {
  const moves = await prisma.stockMove.findMany({
    where: { kind: "RETURN", OR: [{ reason: { startsWith: "return " } }, { reason: { startsWith: "undone return " } }] },
    orderBy: { at: "desc" },
    take: 20_000,
    select: { entryId: true, qty: true, place: true, note: true, at: true, reason: true, product: { select: { model: true } }, by: { select: { name: true } } },
  });
  const byEntry = new Map<string, ReturnBatch & { byModel: Map<string, Record<CountedPlace, number>> }>();
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
    const placed = r.byModel.get(m.product.model) ?? none();
    if (isPlace(m.place)) placed[m.place] += m.qty;
    r.byModel.set(m.product.model, placed);
  }
  return [...byEntry.values()].map(({ byModel, ...r }) => ({
    ...r,
    items: [...byModel].map(([model, placed]) => ({ model, placed, total: COUNTED_PLACES.reduce((n, p) => n + placed[p], 0) })).sort((a, b) => a.model.localeCompare(b.model)),
  }));
}

/** Takes a returns upload back off stock: one added with wrong numbers. The corrected sheet can go in after. */
export async function undoReturn(userId: string, entryId: string): Promise<{ ok: boolean; message: string }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;
      const moves = await tx.stockMove.findMany({
        where: { entryId, kind: "RETURN", reason: { startsWith: "return " } },
        select: { productId: true, place: true, qty: true, note: true, reason: true, at: true, product: { select: { model: true } } },
      });
      if (moves.length === 0) return { ok: false, message: "Those returns were already undone, or are not there." };
      const productIds = [...new Set(moves.map((m) => m.productId))];

      // Counted since: the count already holds what is on the shelf, these returns included.
      if (await countedAfter(tx, productIds, moves[0].at)) {
        return { ok: false, message: "These watches were counted after the returns were added, so the count already has them. Nothing was undone." };
      }

      /*
        What comes back off, place by place, as Receive's undo does it. A sample
        never goes below zero: if the sample from these returns has sold since,
        its piece comes off Sellable instead. Sellable can go below zero, as it
        does when more sold than was counted; that is said.
      */
      const now = await balancesFor(tx, productIds);
      const off = new Map<string, Record<CountedPlace, number>>();
      for (const m of moves) {
        const o = off.get(m.productId) ?? none();
        if (isPlace(m.place)) o[m.place] += m.qty;
        off.set(m.productId, o);
      }
      const modelOf = new Map(moves.map((m) => [m.productId, m.product.model]));
      const below: string[] = [];
      const undoId = randomUUID();
      const reversing = [...off].flatMap(([productId, o]) => {
        const b = now.get(productId) ?? zero();
        for (const sample of ["SAMPLE_TIKTOK", "SAMPLE_EBAY"] as const) {
          const short = o[sample] - Math.max(0, Math.min(o[sample], b[sample]));
          o[sample] -= short;
          o.SELLABLE += short;
        }
        for (const p of COUNTED_PLACES) if (o[p] > 0 && b[p] - o[p] < 0) below.push(`${modelOf.get(productId)} ${COUNTED_LABEL[p]} ${b[p] - o[p]}`);
        return COUNTED_PLACES.filter((p) => o[p] > 0).map((place) => ({
          productId,
          place,
          qty: -o[place],
          kind: "RETURN" as const,
          reason: `undo ${entryId}`,
          note: `Undone: ${moves[0].note}`,
          entryId: undoId,
          byId: userId,
        }));
      });
      await tx.stockMove.createMany({ data: reversing });
      // A model this upload created (kept on its record) and nothing else ever touched — a typo — is switched off.
      // Only those: a model already on the list at zero, never counted or sold, stays as it was.
      const record = await tx.auditLog.findFirst({ where: { entityId: entryId, action: "RETURNED" }, select: { after: true } });
      const createdHere = new Set(((record?.after as { added?: string[] } | null)?.added ?? []));
      for (const productId of productIds) {
        if (!createdHere.has(modelOf.get(productId)!)) continue;
        const other = await tx.stockMove.findFirst({ where: { productId, NOT: { entryId: { in: [entryId, undoId] } } }, select: { id: true } });
        const sold = await tx.stockSale.findFirst({ where: { productId }, select: { id: true } });
        if (!other && !sold) await tx.product.update({ where: { id: productId }, data: { active: false } });
      }
      // No longer returns that were added: not "already added", marked Undone in the log.
      await tx.stockMove.updateMany({ where: { entryId, kind: "RETURN" }, data: { reason: `undone ${moves[0].reason}` } });
      const pieces = moves.reduce((n, m) => n + m.qty, 0);
      await tx.auditLog.create({
        data: {
          entityType: "StockMove",
          entityId: entryId,
          action: "RETURNED_UNDONE",
          actorId: userId,
          summary: `Undid ${moves[0].note}: ${pieces} piece(s) taken back off`,
        },
      });
      return {
        ok: true,
        message:
          `Undone: ${moves[0].note.replace(/^Returned /, "")}. ${pieces} piece(s) taken back off stock.` +
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
    select: { qty: true, place: true, note: true, product: { select: { model: true } } },
  });
  return moves
    .map((m) => ({ ...m, returnedOn: m.note.slice("Returned ".length, "Returned ".length + 10) as DateISO }))
    .filter((m) => m.returnedOn >= from && m.returnedOn <= to);
}

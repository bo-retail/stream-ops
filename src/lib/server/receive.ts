import "server-only";
import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import {
  COUNTED_LABEL,
  COUNTED_PLACES,
  badModelNumber,
  catalogueSpelling,
  normaliseModel,
  parseQty,
  placeReceived,
} from "@/lib/domain/inventory";
import type { CountedPlace } from "@/lib/domain/inventory";
import { sheetRows } from "@/lib/domain/inventory-sheets";
import type { SheetRows } from "@/lib/domain/inventory-sheets";
import type { DateISO } from "@/lib/domain/types";
import { balancesFor, zero } from "./inventory";

/**
 * Receiving inventory, kept simple (Samuel, 10/14).
 *
 * Whoever receives a delivery only counts how many of each model came — a
 * sheet of Model and Quantity — and uploads it. The app decides where they go
 * (`placeReceived`): a model that already has its TikTok and eBay samples gets
 * everything in Sellable; one missing a sample gets it filled first. What is
 * received is added to stock; nothing else is touched.
 *
 * A shipment is added once. Uploaded twice it would double, so each receipt
 * remembers what it held and the day it arrived, and the same again is refused
 * — whatever the file is called, and however often Excel has saved it since.
 */

export interface ReceivedEntry {
  model: string;
  qty: number;
  description: string;
  where: string;
}

const QTY_HEADINGS = ["quantity", "qty", "received", "count", "units"];

/** Headings only the Inventory download has: that file uploaded here would add old deliveries again. */
const DOWNLOAD_HEADINGS = ["received on", "taken from", "total now", "sold in range", "place"];

/** More of one model than this in one delivery is asked about before it is added. */
export const LARGE_QTY = 200;

/** How many days back the same delivery under another date is caught. */
export const REPEAT_DAYS = 7;

/** Reads a filled-in receiving sheet: Model and Quantity. Every problem listed; nothing added until none. */
export async function readReceivingSheet(
  buffer: ArrayBuffer,
): Promise<{ entries: ReceivedEntry[]; problems: string[]; notes: string[] }> {
  let sheets: SheetRows;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    sheets = sheetRows(wb, (c) => /^model$/i.test(c) || /^invicta model$/i.test(c));
  } catch {
    return { entries: [], problems: ["That is not an Excel (.xlsx) file. Download the receiving sheet and fill that in."], notes: [] };
  }
  if (sheets.length === 0) return { entries: [], problems: ['No tab has a "Model" column. Is this the receiving sheet?'], notes: [] };

  const problems: string[] = [];
  const notes: string[] = [];
  const byModel = new Map<string, ReceivedEntry>();
  for (const { sheet, rows } of sheets) {
    if (rows.length === 0) continue;
    const headings = [...new Set(rows.flatMap((r) => Object.keys(r.values)))];
    // Two of its headings, so a column Gladys added herself ("Received on") is not mistaken for it.
    if (headings.filter((h) => DOWNLOAD_HEADINGS.includes(h.trim().toLowerCase())).length >= 2) {
      return {
        entries: [],
        problems: [
          "This is the Inventory download, not a receiving sheet. Download the receiving sheet, fill in what arrived, and upload that.",
        ],
        notes: [],
      };
    }
    const find = (names: string[]) => headings.find((h) => names.includes(h.trim().toLowerCase()));
    const modelKey = find(["model", "invicta model"])!;
    const qtyKey = find(QTY_HEADINGS);
    if (!qtyKey) {
      notes.push(`The "${sheet}" tab has no "Quantity" column, so it was not read.`);
      continue;
    }
    const whatKey = find(["description", "what it is"]);
    for (const { line, values } of rows) {
      const model = normaliseModel(values[modelKey]);
      const where = `${sheet}, row ${line}`;
      const r = parseQty(values[qtyKey]);
      if (r.kind === "bad") {
        problems.push(`${where}${model ? ` (${model})` : ""}: Quantity: ${r.why}.`);
        continue;
      }
      const qty = r.kind === "ok" ? r.qty : 0;
      if (model === "") {
        if (qty > 0) problems.push(`${where}: a quantity but no model number.`);
        continue;
      }
      if (qty === 0) continue;
      const seen = byModel.get(model);
      if (seen) {
        seen.qty += qty;
        notes.push(`${model} was on two rows (${seen.where} and ${where}): they were added together.`);
        continue;
      }
      byModel.set(model, { model, qty, where, description: whatKey ? String(values[whatKey] ?? "").trim() : "" });
    }
  }
  return { entries: [...byModel.values()], problems, notes };
}

export interface ReceiptResult {
  ok: boolean;
  problems: string[];
  models: number;
  pieces: number;
  added: string[];
  /** How many went to each place. */
  placed: Record<CountedPlace, number>;
}

/**
 * What makes two receipts the same: the models and quantities, and the day it
 * arrived — not the file's bytes, which change every time Excel saves it.
 */
function fingerprint(entries: ReceivedEntry[], receivedOn: DateISO | null): string {
  const lines = entries.filter((e) => e.qty > 0).map((e) => `${e.model}|${e.qty}`).sort();
  return createHash("sha256").update([receivedOn ?? "any day", ...lines].join("\n")).digest("hex");
}

/** Adds a received delivery to stock, each model placed by `placeReceived`. */
export async function saveReceipt(
  userId: string,
  entries: ReceivedEntry[],
  receivedOn: DateISO,
  fileName: string,
  /** "Yes, add it anyway": a second identical delivery, or quantities this large really are right. */
  confirmed = false,
): Promise<ReceiptResult> {
  const none = (): Record<CountedPlace, number> => ({ SELLABLE: 0, SAMPLE_TIKTOK: 0, SAMPLE_EBAY: 0, RANDOM_PULLS: 0 });
  const fail = (problems: string[]): ReceiptResult => ({ ok: false, problems, models: 0, pieces: 0, added: [], placed: none() });
  const entryId = randomUUID();

  return prisma.$transaction(
    async (tx) => {
      // The stock lock: nothing else moves stock meanwhile, and two uploads of
      // one delivery cannot both pass the check below.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;

      const products = await tx.product.findMany({ select: { id: true, model: true } });
      const idOf = new Map(products.map((p) => [p.model, p.id]));

      // The catalogue's own spelling ("71" is 0071); two rows of one model added together.
      const spell = catalogueSpelling(idOf.keys());
      const merged = new Map<string, ReceivedEntry>();
      for (const e of entries) {
        const model = spell(e.model);
        const seen = merged.get(model);
        if (seen) seen.qty += e.qty;
        else merged.set(model, { ...e, model });
      }
      const receiving = [...merged.values()].filter((e) => e.qty > 0);
      if (receiving.length === 0) return fail(["Nothing to add: every quantity is blank or 0."]);

      /*
        Caught before anything is added, unless "add it anyway" was ticked:
        the same delivery already added — that day, or under another date in
        the last week (uploaded again the next morning, not sure it went in) —
        and quantities large enough to be a typo. There is an undo, but a
        delivery added twice is easy to miss.
      */
      const sameDay = fingerprint(receiving, receivedOn);
      const anyDay = fingerprint(receiving, null);
      const reason = `receipt ${sameDay} ${anyDay}`;
      if (!confirmed) {
        const before = await tx.stockMove.findFirst({
          where: {
            kind: "RECEIVED",
            OR: [
              { reason: { startsWith: `receipt ${sameDay}` } },
              { reason: { startsWith: "receipt " }, AND: { reason: { endsWith: anyDay } }, at: { gte: new Date(Date.now() - REPEAT_DAYS * 86_400_000) } },
            ],
          },
          select: { note: true },
        });
        if (before) {
          return fail([
            `This delivery looks already added (${before.note}): the same models and quantities. Nothing was added. ` +
              `If it went in with wrong numbers, undo it below. If it really is another, identical delivery, ` +
              `tick "Yes, add it anyway" and upload again.`,
          ]);
        }
        const large = receiving.filter((e) => e.qty > LARGE_QTY);
        if (large.length > 0) {
          return fail([
            `Large quantities: ${large.map((e) => `${e.model} × ${e.qty}`).join(", ")}. Nothing was added. ` +
              `If they are right, tick "Yes, add it anyway" and upload again.`,
          ]);
        }
      }

      const problems = receiving
        .filter((e) => !idOf.has(e.model))
        // A long run of digits is a barcode, or a number Excel rewrote, not a model.
        .map((e) => ({
          e,
          bad: /^\d{9,}$/.test(e.model) ? `"${e.model}" is too long to be a model number. Is it a barcode?` : badModelNumber(e.model),
        }))
        .filter((x) => x.bad !== null)
        .map(({ e, bad }) => `${e.where}: ${bad}${/[.?!]$/.test(bad!) ? "" : "."}`);
      if (problems.length > 0) return fail(problems);

      const added: string[] = [];
      for (const e of receiving) {
        if (idOf.has(e.model)) continue;
        const created = await tx.product.create({
          data: { model: e.model, description: e.description, needsDetails: true, active: true },
          select: { id: true },
        });
        idOf.set(e.model, created.id);
        added.push(e.model);
      }

      // Where each one goes: by what the model holds now, read under the lock.
      const current = await balancesFor(tx, receiving.map((e) => idOf.get(e.model)!));
      const placed = none();
      const note = `Received ${receivedOn} — ${fileName}`;
      const lines = receiving.flatMap((e) => {
        const productId = idOf.get(e.model)!;
        const now = current.get(productId) ?? zero();
        const where = placeReceived(e.qty, { tiktokSample: now.SAMPLE_TIKTOK > 0, ebaySample: now.SAMPLE_EBAY > 0 });
        return COUNTED_PLACES.filter((p) => where[p] > 0).map((place) => {
          placed[place] += where[place];
          return { productId, place, qty: where[place], kind: "RECEIVED" as const, reason, note, entryId, byId: userId };
        });
      });
      await tx.stockMove.createMany({ data: lines });
      await tx.product.updateMany({ where: { id: { in: receiving.map((e) => idOf.get(e.model)!) }, active: false }, data: { active: true } });

      const pieces = lines.reduce((n, l) => n + l.qty, 0);
      await tx.auditLog.create({
        data: {
          entityType: "StockMove",
          entityId: entryId,
          action: "RECEIVED",
          actorId: userId,
          summary:
            `Received ${receivedOn} (${fileName}): ${receiving.length} model(s), ${pieces} piece(s) — ` +
            COUNTED_PLACES.map((p) => `${COUNTED_LABEL[p]} ${placed[p]}`).join(", ") +
            (added.length > 0 ? `; ${added.length} new model(s): ${added.join(", ")}` : ""),
        },
      });
      return { ok: true, problems: [], models: receiving.length, pieces, added, placed };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

/** The receiving sheet: Model, Description, Quantity — one row per model received. */
export async function receivingSheet(today: string): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Received", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.getCell("A1").value =
    `Inventory received — one row per model, and how many came. The app puts them where they belong. ` +
    `Upload it once on Inventory → Receive inventory (downloaded ${today}).`;
  ws.getCell("A1").font = { italic: true, color: { argb: "FF5B6472" } };
  ws.getRow(2).values = ["Model", "Description", "Quantity"];
  ws.getRow(2).font = { bold: true };
  ws.columns = [{ width: 16 }, { width: 44 }, { width: 12 }];
  // Model numbers as text, so Excel never drops a leading zero.
  ws.getColumn(1).numFmt = "@";
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** The latest deliveries added (not undone), newest first — for the undo list. */
export async function recentReceipts(limit = 15) {
  const moves = await prisma.stockMove.findMany({
    where: { kind: "RECEIVED", reason: { startsWith: "receipt " } },
    orderBy: { at: "desc" },
    take: 2_000,
    select: { entryId: true, qty: true, note: true, at: true, productId: true, by: { select: { name: true } } },
  });
  const byEntry = new Map<string, { entryId: string; note: string; at: Date; by: string; pieces: number; models: Set<string> }>();
  for (const m of moves) {
    const r = byEntry.get(m.entryId) ?? { entryId: m.entryId, note: m.note, at: m.at, by: m.by?.name ?? "", pieces: 0, models: new Set<string>() };
    r.pieces += m.qty;
    r.models.add(m.productId);
    byEntry.set(m.entryId, r);
  }
  return [...byEntry.values()].slice(0, limit).map((r) => ({ ...r, models: r.models.size }));
}

/**
 * Takes a delivery back off stock: one uploaded with wrong numbers. Its own
 * pieces come off exactly as they went on, so the corrected sheet can go in
 * after, and it no longer counts as "already added".
 */
export async function undoReceipt(userId: string, entryId: string): Promise<{ ok: boolean; message: string }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;
      const moves = await tx.stockMove.findMany({
        where: { entryId, kind: "RECEIVED", reason: { startsWith: "receipt " } },
        select: { productId: true, place: true, qty: true, note: true, reason: true, at: true },
      });
      if (moves.length === 0) return { ok: false, message: "That delivery was already undone, or is not there." };
      const productIds = [...new Set(moves.map((m) => m.productId))];

      // Counted since: the count already holds what is on the shelf, this delivery included.
      const countedSince = await tx.stockMove.findFirst({
        where: { productId: { in: productIds }, kind: "COUNT", at: { gt: moves[0].at } },
        select: { at: true },
      });
      if (countedSince) {
        return { ok: false, message: "These watches were counted after this delivery, so the count already has them. Nothing was undone." };
      }

      /*
        What comes back off, place by place. A sample never goes below zero:
        if the sample from this delivery has sold since, its piece is taken
        from Sellable instead, so the model still has its sample afterwards.
        Sellable can go below zero, as it does when more sold than was counted;
        that is said.
      */
      const now = await balancesFor(tx, productIds);
      const off = new Map<string, Record<CountedPlace, number>>();
      for (const m of moves) {
        const o = off.get(m.productId) ?? { SELLABLE: 0, SAMPLE_TIKTOK: 0, SAMPLE_EBAY: 0, RANDOM_PULLS: 0 };
        o[m.place as CountedPlace] += m.qty;
        off.set(m.productId, o);
      }
      const below: string[] = [];
      const models = new Map((await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, model: true } })).map((p) => [p.id, p.model]));
      const reversing = [...off].flatMap(([productId, o]) => {
        const b = now.get(productId) ?? zero();
        for (const sample of ["SAMPLE_TIKTOK", "SAMPLE_EBAY"] as const) {
          const short = o[sample] - Math.max(0, Math.min(o[sample], b[sample]));
          o[sample] -= short;
          o.SELLABLE += short;
        }
        for (const p of COUNTED_PLACES) if (o[p] > 0 && b[p] - o[p] < 0) below.push(`${models.get(productId)} ${COUNTED_LABEL[p]} ${b[p] - o[p]}`);
        return COUNTED_PLACES.filter((p) => o[p] > 0).map((place) => ({
          productId,
          place,
          qty: -o[place],
          kind: "RECEIVED" as const,
          reason: `undo ${entryId}`,
          note: `Undone: ${moves[0].note}`,
          entryId: randomUUID(),
          byId: userId,
        }));
      });
      const undoId = randomUUID();
      await tx.stockMove.createMany({ data: reversing.map((r) => ({ ...r, entryId: undoId })) });

      // A model this delivery brought in and nothing else ever touched — a typo — is switched off.
      for (const productId of productIds) {
        const other = await tx.stockMove.findFirst({
          where: { productId, NOT: { entryId: { in: [entryId, undoId] } } },
          select: { id: true },
        });
        const sold = await tx.stockSale.findFirst({ where: { productId }, select: { id: true } });
        if (!other && !sold) await tx.product.update({ where: { id: productId }, data: { active: false } });
      }
      // No longer a delivery that was added: not listed, not "already added".
      await tx.stockMove.updateMany({ where: { entryId, kind: "RECEIVED" }, data: { reason: `undone ${moves[0].reason}` } });
      const pieces = moves.reduce((n, m) => n + m.qty, 0);
      await tx.auditLog.create({
        data: {
          entityType: "StockMove",
          entityId: entryId,
          action: "RECEIVED_UNDONE",
          actorId: userId,
          summary: `Undid ${moves[0].note}: ${pieces} piece(s) taken back off`,
        },
      });
      return {
        ok: true,
        message:
          `Undone: ${moves[0].note.replace(/^Received /, "")}. ${pieces} piece(s) taken back off stock.` +
          (below.length > 0 ? ` Some had sold since, so these are now below zero: ${below.join(", ")}.` : ""),
      };
    },
    { timeout: 60_000, maxWait: 30_000 },
  );
}

/** Every receipt between two dates (by the date received), newest first — for the Excel download. */
export async function receiptsBetween(from: DateISO, to: DateISO) {
  const moves = await prisma.stockMove.findMany({
    where: { kind: "RECEIVED", note: { startsWith: "Received " }, reason: { startsWith: "receipt " } },
    orderBy: { at: "desc" },
    select: { place: true, qty: true, note: true, product: { select: { model: true } } },
  });
  return moves
    .map((m) => ({ ...m, receivedOn: m.note.slice("Received ".length, "Received ".length + 10) as DateISO }))
    .filter((m) => m.receivedOn >= from && m.receivedOn <= to);
}

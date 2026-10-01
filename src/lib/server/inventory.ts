import "server-only";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import {
  PLACES,
  PLACE_LABEL,
  badModelNumber,
  countLines,
  detailsFromMasterRow,
  masterChanges,
  normaliseModel,
  parseQty,
} from "@/lib/domain/inventory";
import type { CountedPlaces, Place, ProductDetails } from "@/lib/domain/inventory";
import { sheetRows } from "@/lib/domain/inventory-sheets";
import type { SheetRows } from "@/lib/domain/inventory-sheets";
import { MAX_PHOTO_BYTES, photoType, pictureFor, storableLink } from "@/lib/domain/watch-images";

/**
 * Inventory, step 1: the catalogue, counts, and what is in stock.
 *
 * Stock is never stored as a number to keep in step. It is the sum of a
 * model's StockMove lines per place, worked out when it is read — a few
 * thousand rows at most, and never out of step with its own history.
 */

/* ---------------------------------------------------------------- the master */

export interface MasterResult {
  ok: boolean;
  added: number;
  updated: number;
  unchanged: number;
  costsFilled: number;
  /** Models with no description, flagged until they get one. */
  flagged: number;
  /** Rows skipped because their model number cannot be one ("Total", a mangled number). */
  skipped: string[];
  problems: string[];
}

const failed = (problem: string): MasterResult => ({
  ok: false, added: 0, updated: 0, unchanged: 0, costsFilled: 0, flagged: 0, skipped: [], problems: [problem],
});

/**
 * Loads Invicta's master file into the catalogue.
 *
 * Takes the rows, not the file: the real master is 24 MB of pictures, so the
 * browser reads it and sends only the columns the catalogue uses (see
 * `inventory-sheets`). Every sheet is read — 19 models are only on the Sample
 * or Random Pulls sheet — and a model on several sheets takes each detail from
 * the first sheet that has it. It adds and updates; it never deletes a model,
 * and never changes a cost already set (see `masterChanges`).
 */
export async function importMaster(userId: string, fileName: string, sheets: SheetRows): Promise<MasterResult> {
  if (sheets.length === 0) return failed('No sheet has an "Invicta Model" column. Is this the master file?');

  const incoming = new Map<string, ProductDetails>();
  const skipped: string[] = [];
  for (const { sheet, rows } of sheets) {
    for (const { line, values } of rows) {
      const d = detailsFromMasterRow(values);
      if (!d) continue;
      // A totals row or a typo would become a model that can never be removed.
      const bad = badModelNumber(d.model);
      if (bad) {
        skipped.push(`${sheet}, row ${line}: ${bad}`);
        continue;
      }
      const have = incoming.get(d.model);
      if (!have) {
        incoming.set(d.model, d);
        continue;
      }
      for (const [k, v] of Object.entries(d) as [keyof ProductDetails, unknown][]) {
        if ((have[k] === "" || have[k] === null) && v !== "" && v !== null) {
          (have as unknown as Record<string, unknown>)[k] = v;
        }
      }
    }
  }
  if (incoming.size === 0) return failed("No models were found in the file.");

  return prisma.$transaction(
    async (tx) => {
      // The same lock as a count, so a model added at a count right now is seen.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;
      const existing = new Map(
        (await tx.product.findMany({ where: { model: { in: [...incoming.keys()] } } })).map((p) => [p.model, p]),
      );

      const fresh = [...incoming.values()].filter((d) => !existing.has(d.model));
      if (fresh.length > 0) {
        await tx.product.createMany({
          // A model with no description is flagged, so it is not taken for finished.
          data: fresh.map((d) => ({ ...d, needsDetails: d.description === "" })),
        });
      }
      let updated = 0;
      let unchanged = 0;
      let costsFilled = 0;
      for (const d of incoming.values()) {
        const current = existing.get(d.model);
        if (!current) continue;
        const changes = masterChanges(current, d);
        const needsDetails = (changes.description ?? current.description) === "";
        if (Object.keys(changes).length === 0 && needsDetails === current.needsDetails) {
          unchanged++;
          continue;
        }
        if (changes.costCents !== undefined) costsFilled++;
        await tx.product.update({ where: { id: current.id }, data: { ...changes, needsDetails } });
        updated++;
      }
      const flagged = await tx.product.count({ where: { model: { in: [...incoming.keys()] }, needsDetails: true } });

      await tx.auditLog.create({
        data: {
          entityType: "Product",
          entityId: "catalogue",
          action: "MASTER_LOADED",
          actorId: userId,
          summary: `Loaded the master file ${fileName}: ${fresh.length} added, ${updated} updated, ${unchanged} unchanged.`,
        },
      });
      return { ok: true, added: fresh.length, updated, unchanged, costsFilled, flagged, skipped, problems: [] };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

/* ------------------------------------------------------------------- stock */

export type Balances = Record<Place, number>;
export const zero = (): Balances => ({ SELLABLE: 0, SAMPLE_EBAY: 0, SAMPLE_TIKTOK: 0, RANDOM_PULLS: 0, DAMAGED: 0 });

export async function balancesFor(
  db: Pick<typeof prisma, "stockMove">,
  productIds?: string[],
): Promise<Map<string, Balances>> {
  const rows = await db.stockMove.groupBy({
    by: ["productId", "place"],
    where: productIds ? { productId: { in: productIds } } : undefined,
    _sum: { qty: true },
  });
  const out = new Map<string, Balances>();
  for (const r of rows) {
    const b = out.get(r.productId) ?? zero();
    b[r.place] = r._sum.qty ?? 0;
    out.set(r.productId, b);
  }
  return out;
}

export interface StockRow {
  model: string;
  description: string;
  collection: string;
  /** What to show as its picture: the uploaded photo, else the master's link, else "". */
  picture: string;
  costCents: number | null;
  needsDetails: boolean;
  /** False until a shipment of it is counted in (a model created from an offer or a shipping list). */
  active: boolean;
  /** When it was last counted, in any place, or null if never. */
  lastCountedAt: Date | null;
  /**
   * When all five places were last counted: the oldest of the five places'
   * latest counts, or null if some place has never been counted. A spot check
   * of one place does not make a model "counted" for a full count.
   */
  fullyCountedAt: Date | null;
  balances: Balances;
  total: number;
}

/** Every model with what is in each place, optionally narrowed by a search. */
export async function listStock(search = ""): Promise<StockRow[]> {
  const q = search.trim();
  const products = await prisma.product.findMany({
    where: q
      ? {
          OR: [
            { model: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
            { collection: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: { model: "asc" },
    select: { id: true, model: true, description: true, collection: true, imageUrl: true, costCents: true, needsDetails: true, active: true, photo: { select: { updatedAt: true } } },
  });
  const ids = q ? products.map((p) => p.id) : undefined;
  const balances = await balancesFor(prisma, ids);
  const lastCount = new Map<string, Map<Place, Date>>();
  for (const r of await prisma.stockMove.groupBy({
    by: ["productId", "place"],
    where: { kind: "COUNT", ...(ids ? { productId: { in: ids } } : {}) },
    _max: { at: true },
  })) {
    const m = lastCount.get(r.productId) ?? new Map<Place, Date>();
    if (r._max.at) m.set(r.place, r._max.at);
    lastCount.set(r.productId, m);
  }
  return products.map((p) => {
    const b = balances.get(p.id) ?? zero();
    return {
      model: p.model,
      description: p.description,
      collection: p.collection,
      picture: pictureFor(p.model, p.imageUrl, p.photo?.updatedAt),
      costCents: p.costCents,
      needsDetails: p.needsDetails,
      active: p.active,
      lastCountedAt: (() => {
        const dates = [...(lastCount.get(p.id)?.values() ?? [])];
        return dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
      })(),
      fullyCountedAt: (() => {
        const m = lastCount.get(p.id);
        if (!m || PLACES.some((place) => !m.has(place))) return null;
        return new Date(Math.min(...PLACES.map((place) => m.get(place)!.getTime())));
      })(),
      balances: b,
      total: PLACES.reduce((n, place) => n + b[place], 0),
    };
  });
}

/** One model: its details, what is where, and every change, newest first. */
export async function getModel(model: string) {
  const product = await prisma.product.findUnique({
    where: { model: normaliseModel(model) },
    include: {
      photo: { select: { updatedAt: true } },
      moves: {
        orderBy: { at: "desc" },
        take: 500,
        select: { id: true, place: true, qty: true, kind: true, countedQty: true, unitCostCents: true, note: true, at: true, by: { select: { name: true } } },
      },
    },
  });
  if (!product) return null;
  const balances = (await balancesFor(prisma, [product.id])).get(product.id) ?? zero();
  return { product, balances };
}

/* ------------------------------------------------------------------ counting */

export interface CountEntry {
  model: string;
  counted: CountedPlaces;
  note?: string;
  /** What it is, for a model that is not in the catalogue yet. */
  description?: string;
  /**
   * Whether this entry may add a model that is not in the catalogue.
   *
   * Only the "not on the list" form and tab may. A model added can never be
   * removed (its history is kept for good), so an unknown model anywhere else —
   * a typo, a totals row, a number Excel mangled — is refused, not created.
   */
  allowNew?: boolean;
  /** Where it came from, for the message: "Count, row 14". */
  where?: string;
}

export interface CountResult {
  ok: boolean;
  models: number;
  changed: number;
  /** Models that were not in the catalogue and were added, flagged for their details. */
  added: string[];
  problems: string[];
}

/**
 * Records a count: for each model and place counted, the difference between
 * what was counted and what the app had.
 *
 * Typed on the count screen or uploaded on the count sheet — both come here.
 * All or nothing: if any entry is refused, nothing is saved. Counts are saved
 * one at a time, so two people saving the same model cannot both work from the
 * same starting number.
 */
export async function saveCount(userId: string, entries: CountEntry[], source: string): Promise<CountResult> {
  const clean = entries
    .map((e) => ({ ...e, model: normaliseModel(e.model) }))
    .filter((e) => e.model !== "" && Object.keys(e.counted).length > 0);
  if (clean.length === 0) {
    return { ok: false, models: 0, changed: 0, added: [], problems: ["Nothing was counted: every box is blank."] };
  }

  const entryId = randomUUID();
  return prisma.$transaction(
    async (tx) => {
      // One count at a time, so a model's starting number is never stale.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;

      const known = new Map(
        (await tx.product.findMany({ where: { model: { in: clean.map((e) => e.model) } }, select: { id: true, model: true } })).map(
          (p) => [p.model, p.id],
        ),
      );

      const problems: string[] = [];
      for (const e of clean) {
        if (known.has(e.model)) continue;
        const at = e.where ? `${e.where}: ` : "";
        if (!e.allowNew) {
          problems.push(
            `${at}${e.model} is not in the catalogue. If it really is a watch that is not on the list, ` +
              `put it on the "Models not on the list" tab (or add it on the count screen).`,
          );
          continue;
        }
        const bad = badModelNumber(e.model);
        if (bad) problems.push(`${at}${bad}${/[.?!]$/.test(bad) ? "" : "."}`);
      }
      if (problems.length > 0) return { ok: false, models: 0, changed: 0, added: [], problems };

      const added: string[] = [];
      for (const e of clean) {
        if (known.has(e.model)) continue;
        const created = await tx.product.create({
          data: { model: e.model, description: e.description?.trim() ?? "", needsDetails: true },
          select: { id: true },
        });
        known.set(e.model, created.id);
        added.push(e.model);
      }

      const current = await balancesFor(tx, [...known.values()]);
      let changed = 0;
      const lines = clean.flatMap((e) => {
        const productId = known.get(e.model)!;
        return countLines(current.get(productId) ?? zero(), e.counted).map((l) => {
          if (l.qty !== 0) changed++;
          return {
            productId,
            place: l.place,
            qty: l.qty,
            countedQty: l.counted,
            kind: "COUNT" as const,
            note: e.note?.trim() ?? "",
            entryId,
            byId: userId,
          };
        });
      });
      await tx.stockMove.createMany({ data: lines });

      await tx.auditLog.create({
        data: {
          entityType: "StockMove",
          entityId: entryId,
          action: "COUNT",
          actorId: userId,
          summary:
            `Counted ${clean.length} model(s) (${source}): ${changed} place(s) changed` +
            (added.length > 0 ? `, ${added.length} new model(s) added: ${added.join(", ")}` : ""),
        },
      });

      return { ok: true, models: clean.length, changed, added, problems: [] };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

/**
 * Reads a filled-in count sheet.
 *
 * Any sheet with a "Model" column must also have all five place columns, so a
 * renamed column is refused rather than quietly skipped. Only the "Models not
 * on the list" tab may add a model. Every problem is listed and nothing is
 * saved until there are none, so a count is never half-loaded.
 */
export async function readCountSheet(buffer: ArrayBuffer): Promise<{ entries: CountEntry[]; problems: string[] }> {
  let sheets: SheetRows;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    sheets = sheetRows(wb, (c) => /^model$/i.test(c));
  } catch {
    return { entries: [], problems: ["That is not an Excel (.xlsx) file. Download the count sheet and fill that in."] };
  }
  if (sheets.length === 0) return { entries: [], problems: ['No sheet has a "Model" column. Is this the count sheet?'] };

  const problems: string[] = [];
  const byModel = new Map<string, CountEntry>();
  for (const { sheet, rows } of sheets) {
    const headings = new Set(rows.flatMap((r) => Object.keys(r.values)).map((h) => h.trim().toLowerCase()));
    const missing = PLACES.filter((p) => !headings.has(PLACE_LABEL[p].toLowerCase()));
    // A sheet with no rows has no headings to read; it is simply empty.
    if (rows.length > 0 && missing.length > 0) {
      problems.push(
        `The "${sheet}" tab has no ${missing.map((p) => `"${PLACE_LABEL[p]}"`).join(", ")} column. ` +
          `Use the count sheet as downloaded, without renaming its columns.`,
      );
      continue;
    }
    const allowNew = /not on the list/i.test(sheet);
    for (const { line, values } of rows) {
      const key = (name: string) => Object.keys(values).find((k) => k.trim().toLowerCase() === name.toLowerCase());
      const modelKey = key("Model");
      const model = normaliseModel(modelKey ? values[modelKey] : null);
      const where = `${sheet}, row ${line}`;
      const counted: CountedPlaces = {};
      for (const place of PLACES) {
        const r = parseQty(values[key(PLACE_LABEL[place])!]);
        if (r.kind === "ok") counted[place] = r.qty;
        if (r.kind === "bad") problems.push(`${where}${model ? ` (${model})` : ""}: ${PLACE_LABEL[place]}: ${r.why}.`);
      }
      if (model === "") {
        if (Object.keys(counted).length > 0) problems.push(`${where}: numbers but no model number.`);
        continue;
      }
      if (Object.keys(counted).length === 0) continue;
      const seen = byModel.get(model);
      if (seen) {
        problems.push(`${model} is counted twice (${seen.where} and ${where}). Put it on one row.`);
        continue;
      }
      const noteKey = key("Notes") ?? key("Note");
      const whatKey = key("What it is") ?? key("Description");
      byModel.set(model, {
        model,
        counted,
        where,
        allowNew,
        note: noteKey ? String(values[noteKey] ?? "") : "",
        description: whatKey ? String(values[whatKey] ?? "") : "",
      });
    }
  }
  return { entries: [...byModel.values()], problems };
}

/* ---------------------------------------------------------------- templates */

/**
 * The count sheet: every model in the catalogue, a column per place, and a
 * second tab for watches on the shelf that are not on the list.
 *
 * The same layout as the opening count sheet already made, so a copy of that
 * one uploads too. Dated, because an old sheet uploaded after a newer count
 * puts the old numbers back.
 */
export async function countSheet(today: string): Promise<ArrayBuffer> {
  const products = await prisma.product.findMany({
    orderBy: { model: "asc" },
    select: { model: true, description: true, collection: true },
  });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Count", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.getCell("A1").value =
    `Downloaded ${today} — download a fresh one for each count. Count every spot of a model and write the total. ` +
    `Leave a box blank if you did not count that place; type 0 if there are none.`;
  ws.getCell("A1").font = { italic: true, color: { argb: "FF5B6472" } };
  ws.getRow(2).values = ["Model", "Description", "Collection", ...PLACES.map((p) => PLACE_LABEL[p]), "Notes"];
  ws.getRow(2).font = { bold: true };
  ws.columns = [{ width: 14 }, { width: 48 }, { width: 18 }, ...PLACES.map(() => ({ width: 13 })), { width: 30 }];
  for (const p of products) ws.addRow([p.model, p.description, p.collection]);
  // Model numbers as text, so Excel never turns them into something else.
  ws.getColumn(1).numFmt = "@";

  const extra = wb.addWorksheet("Models not on the list");
  extra.getCell("A1").value = "Watches found on the shelf that are not on the Count tab. One row each.";
  extra.getCell("A1").font = { italic: true, color: { argb: "FF5B6472" } };
  extra.getRow(2).values = ["Model", "What it is", ...PLACES.map((p) => PLACE_LABEL[p]), "Notes"];
  extra.getRow(2).font = { bold: true };
  extra.columns = [{ width: 14 }, { width: 40 }, ...PLACES.map(() => ({ width: 13 })), { width: 30 }];
  extra.getColumn(1).numFmt = "@";

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/* ------------------------------------------------------------------ pictures */

export type PictureResult = { ok: true } | { ok: false; problem: string };

/**
 * Save a photo of a model, replacing any it had. The bytes must really be a
 * JPEG, PNG or WebP (read from the bytes, not the name) and already small: the
 * page shrinks a phone photo before sending it.
 */
export async function savePhoto(userId: string, model: string, bytes: Uint8Array): Promise<PictureResult> {
  const type = photoType(bytes);
  if (!type) return { ok: false, problem: "That is not a photo the app can show. Use a JPEG, PNG or WebP picture." };
  if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, problem: "That photo is too big. Try again; the page shrinks it first." };
  const product = await prisma.product.findUnique({ where: { model: normaliseModel(model) }, select: { id: true, model: true } });
  if (!product) return { ok: false, problem: `${model} is not in the catalogue.` };
  const data = Uint8Array.from(bytes);
  await prisma.$transaction([
    prisma.productPhoto.upsert({
      where: { productId: product.id },
      create: { productId: product.id, data, contentType: type },
      update: { data, contentType: type },
    }),
    prisma.auditLog.create({
      data: {
        entityType: "Product",
        entityId: product.id,
        action: "PHOTO_SAVED",
        actorId: userId,
        summary: `Uploaded a photo of ${product.model} (${Math.round(bytes.length / 1024)} KB).`,
      },
    }),
  ]);
  return { ok: true };
}

/** Take a model's uploaded photo away, so it shows its link from the master again. */
export async function removePhoto(userId: string, model: string): Promise<PictureResult> {
  const product = await prisma.product.findUnique({ where: { model: normaliseModel(model) }, select: { id: true, model: true } });
  if (!product) return { ok: false, problem: `${model} is not in the catalogue.` };
  // The removal and its record are one step: never a photo gone with no trace.
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.productPhoto.deleteMany({ where: { productId: product.id } });
    if (count > 0) {
      await tx.auditLog.create({
        data: { entityType: "Product", entityId: product.id, action: "PHOTO_REMOVED", actorId: userId, summary: `Removed the photo of ${product.model}.` },
      });
    }
  });
  return { ok: true };
}

/** Set or clear a model's picture link by hand. Blank clears it; anything else must be a web address. */
export async function setImageUrl(userId: string, model: string, raw: string): Promise<PictureResult> {
  const text = raw.trim();
  const imageUrl = storableLink(text);
  if (text !== "" && imageUrl === "") {
    return { ok: false, problem: "That is not a web address. Paste the whole link, starting https://" };
  }
  const product = await prisma.product.findUnique({ where: { model: normaliseModel(model) }, select: { id: true, model: true, imageUrl: true } });
  if (!product) return { ok: false, problem: `${model} is not in the catalogue.` };
  if (imageUrl === product.imageUrl) return { ok: true };
  await prisma.$transaction([
    prisma.product.update({ where: { id: product.id }, data: { imageUrl } }),
    prisma.auditLog.create({
      data: {
        entityType: "Product",
        entityId: product.id,
        action: "IMAGE_URL_SET",
        actorId: userId,
        summary: imageUrl ? `Set the picture link of ${product.model}.` : `Cleared the picture link of ${product.model}.`,
        before: { imageUrl: product.imageUrl },
        after: { imageUrl },
      },
    }),
  ]);
  return { ok: true };
}

/**
 * The picture of each of these models, for any screen that lists watches by
 * stock number (sales insights, the box log). Keyed by the stock number as
 * given; a stock number that is no model in the catalogue — a placeholder
 * listing, a typo — gets "" and shows the plain outline.
 *
 * Never fails the screen it is on: if the catalogue cannot be read (a deploy
 * that went out before its migration, a database hiccup), every watch simply
 * shows no picture and sales insights or the box log work as before.
 */
export async function picturesFor(stockNumbers: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(stockNumbers.map(normaliseModel).filter((m) => m !== ""))];
  let products: { model: string; imageUrl: string; photo: { updatedAt: Date } | null }[] = [];
  if (wanted.length > 0) {
    try {
      products = await prisma.product.findMany({
        where: { model: { in: wanted } },
        select: { model: true, imageUrl: true, photo: { select: { updatedAt: true } } },
      });
    } catch (e) {
      console.error("picturesFor: no pictures this time", e);
    }
  }
  const byModel = new Map(products.map((p) => [p.model, pictureFor(p.model, p.imageUrl, p.photo?.updatedAt)]));
  return new Map(stockNumbers.map((s) => [s, byModel.get(normaliseModel(s)) ?? ""]));
}

/** A model's uploaded photo, for the picture route. */
export async function readPhoto(model: string): Promise<{ data: Uint8Array; contentType: string } | null> {
  const photo = await prisma.productPhoto.findFirst({
    where: { product: { model: normaliseModel(model) } },
    select: { data: true, contentType: true },
  });
  return photo ? { data: photo.data, contentType: photo.contentType } : null;
}

import "server-only";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { fromDbDate, toDbDate, todayISO } from "@/lib/domain/dates";
import { PLACES, badModelNumber, normaliseModel } from "@/lib/domain/inventory";
import { sheetRows } from "@/lib/domain/inventory-sheets";
import type { SheetRows } from "@/lib/domain/inventory-sheets";
import {
  STILL_TO_COME_DAYS,
  differences,
  readLineCount,
  readOffer,
  readShippingList,
  receiptChange,
  stillToCome,
  weightedCost,
} from "@/lib/domain/receiving";
import type { DifferenceKind, LineCount } from "@/lib/domain/receiving";
import type { DateISO } from "@/lib/domain/types";
import { balancesFor, picturesFor, zero } from "./inventory";
import { getSettings } from "./settings";

/**
 * Inventory, step 2: receiving.
 *
 * Daniel's offer creates the models he ordered (inactive until they arrive),
 * Invicta's shipping list says what to expect, and Gladys's count of the
 * shipment is what moves stock — at the shipping-list cost, with the model's
 * cost becoming the weighted average. Differences with Invicta stay on screen
 * until somebody settles them.
 *
 * Every write takes the same lock as a shelf count, so stock is only ever
 * changed by one save at a time.
 */

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const lockStock = (tx: Tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;

const TX = { timeout: 120_000, maxWait: 30_000 };

/* -------------------------------------------------------------------- offers */

export interface OfferResult {
  ok: boolean;
  lines: number;
  pieces: number;
  created: string[];
  replaced: boolean;
  problems: string[];
}

/**
 * An offer, uploaded. Saved under its date; the same date again replaces it.
 *
 * A model it orders that the app has never seen is created inactive, with the
 * offer's brand, collection, gender, picture and cost. On a model already
 * known, those only fill what is blank — the product details always win.
 */
export async function importOffer(userId: string, fileName: string, date: DateISO, sheets: SheetRows): Promise<OfferResult> {
  const fail = (problems: string[]): OfferResult => ({ ok: false, lines: 0, pieces: 0, created: [], replaced: false, problems });
  const { lines, problems } = readOffer(sheets);
  if (problems.length > 0) return fail(problems);
  if (lines.length === 0) return fail(['No line has a quantity in the "Dani" column. Is this the offer?']);

  return prisma.$transaction(async (tx) => {
    await lockStock(tx);
    const existing = await tx.offer.findUnique({ where: { date: toDbDate(date) }, select: { id: true } });
    if (existing) await tx.offerLine.deleteMany({ where: { offerId: existing.id } });
    const offer = existing
      ? await tx.offer.update({ where: { id: existing.id }, data: { fileName, uploadedAt: new Date(), byId: userId } })
      : await tx.offer.create({ data: { date: toDbDate(date), fileName, byId: userId } });

    const known = new Map(
      (
        await tx.product.findMany({
          where: { model: { in: lines.map((l) => l.model) } },
          select: { id: true, model: true, brand: true, collection: true, gender: true, imageUrl: true, costCents: true },
        })
      ).map((p) => [p.model, p]),
    );
    const created: string[] = [];
    const ids = new Map<string, string>();
    for (const l of lines) {
      const p = known.get(l.model);
      if (!p) {
        const made = await tx.product.create({
          data: {
            model: l.model,
            brand: l.brand,
            collection: l.collection,
            gender: l.gender,
            imageUrl: l.imageUrl,
            costCents: l.costCents,
            active: false,
            needsDetails: true,
          },
          select: { id: true },
        });
        ids.set(l.model, made.id);
        created.push(l.model);
        continue;
      }
      ids.set(l.model, p.id);
      const fill: Record<string, string | number> = {};
      if (!p.brand && l.brand) fill.brand = l.brand;
      if (!p.collection && l.collection) fill.collection = l.collection;
      if (!p.gender && l.gender) fill.gender = l.gender;
      if (!p.imageUrl && l.imageUrl) fill.imageUrl = l.imageUrl;
      if (p.costCents === null) fill.costCents = l.costCents;
      if (Object.keys(fill).length > 0) await tx.product.update({ where: { id: p.id }, data: fill });
    }
    await tx.offerLine.createMany({
      data: lines.map((l) => ({ offerId: offer.id, productId: ids.get(l.model)!, qty: l.qty, costCents: l.costCents })),
    });
    const pieces = lines.reduce((n, l) => n + l.qty, 0);
    await tx.auditLog.create({
      data: {
        entityType: "Offer",
        entityId: offer.id,
        action: existing ? "OFFER_REPLACED" : "OFFER_LOADED",
        actorId: userId,
        summary:
          `${existing ? "Replaced" : "Loaded"} the offer of ${date} from ${fileName}: ${lines.length} model(s), ${pieces} piece(s)` +
          (created.length > 0 ? `, ${created.length} new model(s) created inactive: ${created.join(", ")}` : "") +
          ".",
      },
    });
    return { ok: true, lines: lines.length, pieces, created, replaced: existing !== null, problems: [] };
  }, TX);
}

/* ------------------------------------------------------------ shipping lists */

export interface ShippingListResult {
  ok: boolean;
  shipments: { sop: string; lines: number; pieces: number; replaced: boolean }[];
  created: string[];
  problems: string[];
}

/**
 * Invicta's shipping list, uploaded. Nothing goes into stock: the shipment
 * waits for Gladys's count.
 *
 * The same SOP uploaded again replaces its list, until it has been counted;
 * after that it is refused, because the count and its differences are already
 * written against it. A model on the list that the app has never seen is
 * created inactive, so it can be counted in.
 */
export async function importShippingList(userId: string, fileName: string, sheets: SheetRows): Promise<ShippingListResult> {
  const fail = (problems: string[]): ShippingListResult => ({ ok: false, shipments: [], created: [], problems });
  const { shipments, problems } = readShippingList(sheets);
  if (problems.length > 0) return fail(problems);
  if (shipments.length === 0) return fail(['No line has an SOP number, an item and a quantity. Is this Invicta\'s shipping list?']);

  return prisma.$transaction(async (tx) => {
    await lockStock(tx);
    const before = await tx.shipment.findMany({
      where: { sop: { in: shipments.map((s) => s.sop) } },
      select: { id: true, sop: true, countedAt: true },
    });
    const counted = before.filter((s) => s.countedAt !== null).map((s) => s.sop);
    if (counted.length > 0) {
      return fail([
        `${counted.join(", ")} ${counted.length === 1 ? "has" : "have"} already been counted, so the list cannot be replaced. ` +
          `Any difference with Invicta is settled on the shipment's page instead.`,
      ]);
    }

    const models = [...new Set(shipments.flatMap((s) => s.lines.map((l) => l.model)))];
    const ids = new Map((await tx.product.findMany({ where: { model: { in: models } }, select: { id: true, model: true } })).map((p) => [p.model, p.id]));
    const created: string[] = [];
    for (const model of models) {
      if (ids.has(model)) continue;
      const made = await tx.product.create({ data: { model, active: false, needsDetails: true }, select: { id: true } });
      ids.set(model, made.id);
      created.push(model);
    }

    const out: ShippingListResult["shipments"] = [];
    for (const s of shipments) {
      const old = before.find((b) => b.sop === s.sop);
      if (old) await tx.shipmentLine.deleteMany({ where: { shipmentId: old.id } });
      const shipment = old
        ? await tx.shipment.update({ where: { id: old.id }, data: { po: s.po, fileName, uploadedAt: new Date(), byId: userId } })
        : await tx.shipment.create({ data: { sop: s.sop, po: s.po, fileName, byId: userId } });
      await tx.shipmentLine.createMany({
        data: s.lines.map((l) => ({ shipmentId: shipment.id, productId: ids.get(l.model)!, listedQty: l.qty, unitCostCents: l.unitCostCents })),
      });
      const pieces = s.lines.reduce((n, l) => n + l.qty, 0);
      out.push({ sop: s.sop, lines: s.lines.length, pieces, replaced: old !== undefined });
      await tx.auditLog.create({
        data: {
          entityType: "Shipment",
          entityId: shipment.id,
          action: old ? "SHIPPING_LIST_REPLACED" : "SHIPPING_LIST_LOADED",
          actorId: userId,
          summary: `${old ? "Replaced" : "Loaded"} the shipping list for ${s.sop} from ${fileName}: ${s.lines.length} model(s), ${pieces} piece(s).`,
        },
      });
    }
    return { ok: true, shipments: out, created, problems: [] };
  }, TX);
}

/* ----------------------------------------------------------- counting it in */

export interface ShipmentCountEntry {
  model: string;
  counted: number;
  damaged: number;
  /** Where it came from, for a problem message ("row 7"). */
  where?: string;
}

export interface ShipmentCountResult {
  ok: boolean;
  /** Lines whose count changed stock. */
  changed: number;
  /** Models made active by this count. */
  activated: string[];
  /** Models counted that were not on the list. */
  notOnList: string[];
  costChanges: { model: string; before: number | null; after: number | null }[];
  problems: string[];
}

/**
 * Gladys's count of a shipment — typed on its page or uploaded on its sheet.
 *
 * For each model counted, stock changes by the difference from what was saved
 * for it before (nothing, the first time): good pieces to Sellable, damaged to
 * Damaged, at the shipping-list cost. The model's cost becomes the weighted
 * average, and a model created inactive becomes active once a good piece is
 * in. A model that came in the boxes without being on the list is added as a
 * line of its own. All or nothing.
 */
export async function saveShipmentCount(userId: string, sop: string, entries: ShipmentCountEntry[], source: string): Promise<ShipmentCountResult> {
  const fail = (problems: string[]): ShipmentCountResult => ({ ok: false, changed: 0, activated: [], notOnList: [], costChanges: [], problems });
  const clean = entries.map((e) => ({ ...e, model: normaliseModel(e.model) }));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of clean) {
    const at = e.where ? `${e.where}: ` : "";
    const bad = badModelNumber(e.model);
    if (bad) problems.push(`${at}${bad}.`);
    else if (seen.has(e.model)) problems.push(`${at}${e.model} is counted twice. Put it on one row.`);
    if (!Number.isInteger(e.counted) || !Number.isInteger(e.damaged) || e.counted < 0 || e.damaged < 0 || e.damaged > e.counted) {
      problems.push(`${at}${e.model}: ${e.damaged} damaged out of ${e.counted} counted does not add up.`);
    }
    seen.add(e.model);
  }
  if (problems.length > 0) return fail(problems);
  if (clean.length === 0) return fail(["Nothing was counted: every box is blank."]);

  const entryId = randomUUID();
  return prisma.$transaction(async (tx) => {
    await lockStock(tx);
    const shipment = await tx.shipment.findUnique({
      where: { sop: sop.trim().toUpperCase() },
      select: { id: true, sop: true, lines: { select: { id: true, productId: true, listedQty: true, unitCostCents: true, countedQty: true, damagedQty: true, product: { select: { model: true } } } } },
    });
    if (!shipment) return fail([`There is no shipment ${sop}. Upload its shipping list first.`]);

    const lineOf = new Map(shipment.lines.map((l) => [l.product.model, l]));
    const products = new Map(
      (
        await tx.product.findMany({
          where: { model: { in: clean.map((e) => e.model) } },
          select: { id: true, model: true, costCents: true, active: true },
        })
      ).map((p) => [p.model, p]),
    );

    // Models that came in the boxes without being on the list: a product if
    // the app has never seen it, and a line of their own at the offer's cost.
    const notOnList: string[] = [];
    for (const e of clean) {
      if (lineOf.has(e.model)) continue;
      if (e.counted === 0) continue;
      let p = products.get(e.model);
      if (!p) {
        const made = await tx.product.create({ data: { model: e.model, active: false, needsDetails: true }, select: { id: true, model: true, costCents: true, active: true } });
        products.set(e.model, made);
        p = made;
      }
      const offered = await tx.offerLine.findFirst({ where: { productId: p.id }, orderBy: { offer: { date: "desc" } }, select: { costCents: true } });
      const line = await tx.shipmentLine.create({
        data: { shipmentId: shipment.id, productId: p.id, listedQty: 0, unitCostCents: offered?.costCents ?? null },
        select: { id: true, productId: true, listedQty: true, unitCostCents: true, countedQty: true, damagedQty: true },
      });
      lineOf.set(e.model, { ...line, product: { model: e.model } });
      notOnList.push(e.model);
    }

    const productIds = [...new Set(clean.flatMap((e) => (lineOf.get(e.model) ? [lineOf.get(e.model)!.productId] : [])))];
    const balances = await balancesFor(tx, productIds);
    const costs = new Map([...products.values()].map((p) => [p.id, p.costCents]));

    let changed = 0;
    const activated: string[] = [];
    const costChanges: ShipmentCountResult["costChanges"] = [];
    const moves: {
      productId: string; place: "SELLABLE" | "DAMAGED"; qty: number; kind: "RECEIVED"; unitCostCents: number | null;
      shipmentId: string; note: string; entryId: string; byId: string;
    }[] = [];

    for (const e of clean) {
      const line = lineOf.get(e.model);
      if (!line) continue; // counted 0 and not on the list: nothing to record
      const before: LineCount | null = line.countedQty === null ? null : { counted: line.countedQty, damaged: line.damagedQty ?? 0 };
      const after = { counted: e.counted, damaged: e.damaged };
      const change = receiptChange(before, after);
      const cost = line.unitCostCents ?? costs.get(line.productId) ?? null;
      const note = `Shipment ${shipment.sop}`;
      if (change.sellable !== 0) moves.push({ productId: line.productId, place: "SELLABLE", qty: change.sellable, kind: "RECEIVED", unitCostCents: cost, shipmentId: shipment.id, note, entryId, byId: userId });
      if (change.damaged !== 0) moves.push({ productId: line.productId, place: "DAMAGED", qty: change.damaged, kind: "RECEIVED", unitCostCents: cost, shipmentId: shipment.id, note: `${note}, damaged on arrival`, entryId, byId: userId });

      const sameCount = before !== null && before.counted === after.counted && before.damaged === after.damaged;
      if (!sameCount) {
        changed++;
        await tx.shipmentLine.update({
          where: { id: line.id },
          // A count that changes reopens a difference that was settled on the old numbers.
          data: { countedQty: after.counted, damagedQty: after.damaged, settledAt: null, settledNote: "", settledById: null },
        });
      }

      const onHand = PLACES.reduce((n, place) => n + (balances.get(line.productId) ?? zero())[place], 0);
      const was = costs.get(line.productId) ?? null;
      const now = weightedCost(was, onHand, line.unitCostCents, change.pieces);
      const product = [...products.values()].find((p) => p.id === line.productId)!;
      const data: { costCents?: number | null; active?: boolean } = {};
      if (now !== was) {
        data.costCents = now;
        costs.set(line.productId, now);
        costChanges.push({ model: e.model, before: was, after: now });
      }
      if (!product.active && after.counted - after.damaged > 0) {
        data.active = true;
        product.active = true;
        activated.push(e.model);
      }
      if (Object.keys(data).length > 0) await tx.product.update({ where: { id: line.productId }, data });
      // Later lines of the same model in this save see this one's pieces.
      const b = balances.get(line.productId) ?? zero();
      b.SELLABLE += change.sellable;
      b.DAMAGED += change.damaged;
      balances.set(line.productId, b);
    }

    if (moves.length > 0) await tx.stockMove.createMany({ data: moves });
    await tx.shipment.update({ where: { id: shipment.id }, data: { countedAt: new Date() } });
    await tx.auditLog.create({
      data: {
        entityType: "Shipment",
        entityId: shipment.id,
        action: "SHIPMENT_COUNTED",
        actorId: userId,
        summary:
          `Counted ${clean.length} model(s) of ${shipment.sop} (${source}): ${changed} line(s) changed` +
          (activated.length > 0 ? `; now active: ${activated.join(", ")}` : "") +
          (notOnList.length > 0 ? `; not on the list: ${notOnList.join(", ")}` : "") +
          ".",
        after: costChanges.length > 0 ? { costChanges } : undefined,
      },
    });
    return { ok: true, changed, activated, notOnList, costChanges, problems: [] };
  }, TX);
}

/** Mark one line's difference with Invicta settled, with what settled it. */
export async function settleDifference(userId: string, lineId: string, note: string): Promise<{ ok: boolean; problem?: string }> {
  const line = await prisma.shipmentLine.findUnique({
    where: { id: lineId },
    select: { id: true, settledAt: true, countedQty: true, shipment: { select: { sop: true } }, product: { select: { model: true } } },
  });
  if (!line) return { ok: false, problem: "That line is not there any more. Refresh the page." };
  if (line.countedQty === null) return { ok: false, problem: "That line has not been counted yet." };
  if (line.settledAt) return { ok: true };
  const text = note.trim().slice(0, 500);
  await prisma.$transaction([
    prisma.shipmentLine.update({ where: { id: lineId }, data: { settledAt: new Date(), settledNote: text, settledById: userId } }),
    prisma.auditLog.create({
      data: {
        entityType: "ShipmentLine",
        entityId: lineId,
        action: "DIFFERENCE_SETTLED",
        actorId: userId,
        summary: `Settled the difference on ${line.product.model} in ${line.shipment.sop}${text ? `: ${text}` : "."}`,
      },
    }),
  ]);
  return { ok: true };
}

/* --------------------------------------------------------------- reading */

export interface OpenDifference {
  lineId: string;
  sop: string;
  model: string;
  picture: string;
  listed: number;
  counted: number;
  damaged: number;
  kinds: { kind: DifferenceKind; qty: number }[];
}

/** Everything the receiving page shows. */
export async function getReceiving() {
  const today = todayISO((await getSettings()).timezone);
  const tz = (await getSettings()).timezone;
  const [offers, shipments, open] = await Promise.all([
    prisma.offer.findMany({
      orderBy: { date: "desc" },
      take: 12,
      select: { id: true, date: true, fileName: true, uploadedAt: true, lines: { select: { qty: true } } },
    }),
    prisma.shipment.findMany({
      orderBy: { uploadedAt: "desc" },
      take: 30,
      select: {
        id: true, sop: true, po: true, uploadedAt: true, countedAt: true,
        lines: { select: { listedQty: true, countedQty: true, damagedQty: true, settledAt: true } },
      },
    }),
    prisma.shipmentLine.findMany({
      where: { countedQty: { not: null }, settledAt: null },
      select: { id: true, listedQty: true, countedQty: true, damagedQty: true, shipment: { select: { sop: true, uploadedAt: true } }, product: { select: { model: true } } },
      orderBy: [{ shipment: { uploadedAt: "asc" } }],
    }),
  ]);

  const toCome = await getStillToCome(today, tz);
  const differencesOpen = open
    .map((l) => ({ l, kinds: differences(l) }))
    .filter((x) => x.kinds.length > 0);
  const pictures = await picturesFor([...differencesOpen.map((x) => x.l.product.model), ...toCome.map((t) => t.model)]);

  return {
    today,
    offers: offers.map((o) => ({
      id: o.id,
      date: fromDbDate(o.date),
      fileName: o.fileName,
      uploadedAt: o.uploadedAt,
      models: o.lines.length,
      pieces: o.lines.reduce((n, l) => n + l.qty, 0),
    })),
    shipments: shipments.map((s) => ({
      id: s.id,
      sop: s.sop,
      po: s.po,
      uploadedAt: s.uploadedAt,
      countedAt: s.countedAt,
      models: s.lines.filter((l) => l.listedQty > 0).length,
      listed: s.lines.reduce((n, l) => n + l.listedQty, 0),
      counted: s.countedAt ? s.lines.reduce((n, l) => n + (l.countedQty ?? 0), 0) : null,
      openDifferences: s.lines.filter((l) => !l.settledAt && differences(l).length > 0).length,
    })),
    toCome: toCome.map((t) => ({ ...t, picture: pictures.get(t.model) ?? "" })),
    differences: differencesOpen.map(({ l, kinds }): OpenDifference => ({
      lineId: l.id,
      sop: l.shipment.sop,
      model: l.product.model,
      picture: pictures.get(l.product.model) ?? "",
      listed: l.listedQty,
      counted: l.countedQty ?? 0,
      damaged: l.damagedQty ?? 0,
      kinds,
    })),
  };
}

/**
 * What was ordered and not yet shipped. Older offers are read too (twice the
 * window), because a shipment fills the oldest offer of a model first.
 */
async function getStillToCome(today: DateISO, tz: string) {
  const from = new Date(`${today}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - STILL_TO_COME_DAYS * 2);
  const offers = await prisma.offer.findMany({
    where: { date: { gte: from } },
    select: { date: true, lines: { select: { qty: true, product: { select: { model: true, description: true } } } } },
  });
  if (offers.length === 0) return [];
  const shipped = await prisma.shipmentLine.findMany({
    where: { listedQty: { gt: 0 }, shipment: { uploadedAt: { gte: from } } },
    select: { listedQty: true, product: { select: { model: true } }, shipment: { select: { uploadedAt: true } } },
  });
  const description = new Map(offers.flatMap((o) => o.lines.map((l) => [l.product.model, l.product.description] as const)));
  return stillToCome(
    offers.map((o) => ({ date: fromDbDate(o.date), lines: o.lines.map((l) => ({ model: l.product.model, qty: l.qty })) })),
    shipped.map((s) => ({ date: todayISO(tz, s.shipment.uploadedAt), model: s.product.model, qty: s.listedQty })),
    today,
  ).map((t) => ({ ...t, description: description.get(t.model) ?? "" }));
}

/** One offer, line by line, with whether each model is new to the app. */
export async function getOffer(date: DateISO) {
  const offer = await prisma.offer.findUnique({
    where: { date: toDbDate(date) },
    select: {
      id: true, date: true, fileName: true, uploadedAt: true, by: { select: { name: true } },
      lines: {
        orderBy: { product: { model: "asc" } },
        select: { qty: true, costCents: true, product: { select: { model: true, description: true, active: true, needsDetails: true } } },
      },
    },
  });
  if (!offer) return null;
  const pictures = await picturesFor(offer.lines.map((l) => l.product.model));
  return {
    ...offer,
    date: fromDbDate(offer.date),
    lines: offer.lines.map((l) => ({ ...l, picture: pictures.get(l.product.model) ?? "" })),
  };
}

/** One shipment, line by line, with the offer's price beside the list's. */
export async function getShipment(sop: string) {
  const shipment = await prisma.shipment.findUnique({
    where: { sop: sop.trim().toUpperCase() },
    select: {
      id: true, sop: true, po: true, fileName: true, uploadedAt: true, countedAt: true, by: { select: { name: true } },
      lines: {
        orderBy: [{ listedQty: "desc" }, { product: { model: "asc" } }],
        select: {
          id: true, listedQty: true, unitCostCents: true, countedQty: true, damagedQty: true, settledAt: true, settledNote: true,
          settledBy: { select: { name: true } },
          product: { select: { id: true, model: true, description: true, active: true, needsDetails: true } },
        },
      },
    },
  });
  if (!shipment) return null;
  const productIds = shipment.lines.map((l) => l.product.id);
  const offered = await prisma.offerLine.findMany({
    where: { productId: { in: productIds } },
    orderBy: { offer: { date: "desc" } },
    select: { productId: true, costCents: true, offer: { select: { date: true } } },
  });
  const offerCost = new Map<string, { costCents: number; date: DateISO }>();
  for (const o of offered) if (!offerCost.has(o.productId)) offerCost.set(o.productId, { costCents: o.costCents, date: fromDbDate(o.offer.date) });
  const pictures = await picturesFor(shipment.lines.map((l) => l.product.model));
  return {
    ...shipment,
    lines: shipment.lines.map((l) => ({
      ...l,
      picture: pictures.get(l.product.model) ?? "",
      offer: offerCost.get(l.product.id) ?? null,
      differences: differences(l),
    })),
  };
}

/* ------------------------------------------------------------ the count sheet */

const COUNT_HEADINGS = ["SOP", "Model", "Description", "On the list", "Counted", "Damaged on arrival", "Notes"];

/**
 * A shipment's count sheet: every model on its list, with a box for what was
 * counted and how many of those arrived damaged. Rows can be added at the
 * bottom for anything that came in the boxes without being on the list.
 */
export async function shipmentCountSheet(sop: string): Promise<ArrayBuffer | null> {
  const s = await getShipment(sop);
  if (!s) return null;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Shipment count", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.getCell("A1").value =
    `Shipment ${s.sop}. Count what came out of the boxes. Counted includes the damaged ones. ` +
    `Add a row at the bottom for anything that is not on the list.`;
  ws.getCell("A1").font = { italic: true, color: { argb: "FF5B6472" } };
  ws.getRow(2).values = COUNT_HEADINGS;
  ws.getRow(2).font = { bold: true };
  ws.columns = [{ width: 13 }, { width: 14 }, { width: 44 }, { width: 11 }, { width: 10 }, { width: 18 }, { width: 30 }];
  for (const l of s.lines) {
    ws.addRow([s.sop, l.product.model, l.product.description, l.listedQty, l.countedQty, l.countedQty === null ? null : l.damagedQty]);
  }
  ws.getColumn(2).numFmt = "@";
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** A filled-in shipment count sheet. Rows left blank are not counted. */
export async function readShipmentCountSheet(buffer: ArrayBuffer): Promise<{ sop: string; entries: ShipmentCountEntry[]; problems: string[] }> {
  let sheets: SheetRows;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    sheets = sheetRows(wb, (c) => /^counted$/i.test(c.trim()));
  } catch {
    return { sop: "", entries: [], problems: ["That is not an Excel (.xlsx) file. Download the shipment's count sheet and fill that in."] };
  }
  if (sheets.length === 0) return { sop: "", entries: [], problems: ['No sheet has a "Counted" column. Is this a shipment count sheet?'] };
  const problems: string[] = [];
  const entries: ShipmentCountEntry[] = [];
  const sops = new Set<string>();
  for (const { sheet, rows } of sheets) {
    for (const { line, values } of rows) {
      const get = (name: string) => {
        const k = Object.keys(values).find((h) => h.trim().toLowerCase() === name.toLowerCase());
        return k === undefined ? null : values[k];
      };
      const model = normaliseModel(get("Model"));
      const where = `${sheet}, row ${line}`;
      const r = readLineCount(get("Counted"), get("Damaged on arrival") ?? get("Damaged"));
      if (r.ok === "blank") continue;
      if (r.ok === false) {
        problems.push(`${where}${model ? ` (${model})` : ""}: ${r.why}`);
        continue;
      }
      if (model === "") {
        problems.push(`${where}: a count but no model number.`);
        continue;
      }
      const sop = String(get("SOP") ?? "").trim().toUpperCase();
      if (sop) sops.add(sop);
      entries.push({ model, ...r.count, where });
    }
  }
  if (sops.size > 1) problems.push(`The sheet has more than one SOP (${[...sops].join(", ")}). Count one shipment per sheet.`);
  return { sop: [...sops][0] ?? "", entries, problems };
}

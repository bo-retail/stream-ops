import "server-only";
import { prisma } from "@/lib/db";
import { addDays, fromDbDate, toDbDate, todayISO } from "@/lib/domain/dates";
import { planDeduction, wantedSales } from "@/lib/domain/deduction";
import type { BoxState, KnownSale, Plan, SaleLine, Wanted } from "@/lib/domain/deduction";
import { listingOfNote } from "@/lib/domain/imports/placeholders";
import { normaliseStockNumber } from "@/lib/domain/imports/tracking";
import { PLACES } from "@/lib/domain/inventory";
import type { Place } from "@/lib/domain/inventory";
import type { DateISO } from "@/lib/domain/types";
import { balancesFor } from "./inventory";
import { latestBatchIds } from "./sales-data";
import { getSettings } from "./settings";

/**
 * Inventory, step 3: bringing stock up to date with the reports and packing.
 *
 * Runs after every upload of the day's reports and whenever the inventory
 * pages are opened. Each run compares what the reports and the boxes say with
 * what stock already took off (see `domain/deduction`), and writes only the
 * difference — so it can run any number of times, and two runs at once simply
 * queue on the stock lock.
 *
 * Nothing at all happens until a director sets the start date: before the
 * opening count, sales never move stock.
 */

/**
 * How far back a run looks. Reports for older days are not re-read, so a run
 * stays quick however long the app has been in use; a correction to a report
 * older than this is rare enough to be done with an adjustment.
 */
export const LOOK_BACK_DAYS = 14;

export interface StockUpToDate {
  /** False until a director sets the day sales start coming off. */
  on: boolean;
  startDate: DateISO | null;
  sold: number;
  sent: number;
  putBack: number;
  unsent: number;
  flagged: number;
  unnamed: Wanted[];
  unknown: Wanted[];
}

const OFF: StockUpToDate = { on: false, startDate: null, sold: 0, sent: 0, putBack: 0, unsent: 0, flagged: 0, unnamed: [], unknown: [] };

const readStart = async () =>
  (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { timezone: true, inventoryStartDate: true } })) ?? {
    timezone: (await getSettings()).timezone,
    inventoryStartDate: null,
  };

/** The first show day whose sales come off, or null while that is off. */
export async function getStartDate(): Promise<DateISO | null> {
  const s = await readStart();
  return s.inventoryStartDate ? fromDbDate(s.inventoryStartDate) : null;
}

/** Bring stock up to date. Returns what it did, and what it could not do. */
export async function bringStockUpToDate(actorId: string | null): Promise<StockUpToDate> {
  // Read fresh, not from the per-request cache: a start date set a moment ago counts.
  const settings = await readStart();
  if (!settings.inventoryStartDate) return OFF;
  const start = fromDbDate(settings.inventoryStartDate);
  const today = todayISO(settings.timezone);
  const lookBack = addDays(today, -LOOK_BACK_DAYS);
  const from = start > lookBack ? start : lookBack;
  // Reports can name tomorrow's date for a late night show; read a day ahead.
  const to = addDays(today, 1);

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;

      const batchIds = await latestBatchIds(from, to);
      const rows = await tx.salesRecord.findMany({
        where: { batchId: { in: batchIds }, business: "WATCH", showDate: { gte: toDbDate(from), lte: toDbDate(to) } },
        select: { platform: true, orderRef: true, lineRef: true, showDate: true, show: true, tracking: true, stockNumber: true, modelNumber: true, qty: true },
      });
      const lines: SaleLine[] = rows.map((r) => ({ ...r, showDate: fromDbDate(r.showDate) }));

      const trackings = [...new Set(lines.map((l) => l.tracking).filter(Boolean))];
      const packages = await tx.package.findMany({
        where: { trackingNumber: { in: trackings } },
        select: {
          trackingNumber: true,
          status: true,
          items: { select: { stockNumber: true, scannedQty: true } },
          scans: { where: { kind: "ITEM_PLACEHOLDER" }, orderBy: { at: "asc" }, select: { stockNumber: true, note: true } },
        },
      });
      const boxes = new Map<string, BoxState>(
        packages.map((p) => {
          const pieces: Record<string, string[]> = {};
          for (const s of p.scans) {
            const listing = listingOfNote(s.note);
            if (!listing || !s.stockNumber) continue;
            (pieces[normaliseStockNumber(listing)] ??= []).push(s.stockNumber);
          }
          return [
            p.trackingNumber,
            { status: p.status, scanned: Object.fromEntries(p.items.map((i) => [normaliseStockNumber(i.stockNumber), i.scannedQty])), pieces },
          ];
        }),
      );

      const products = await tx.product.findMany({ select: { id: true, model: true, costCents: true } });
      const byModel = new Map(products.map((p) => [p.model, p]));
      const wanted = wantedSales(lines, boxes, (m) => byModel.has(m));

      // Everything in the look-back window — including sales from before a start
      // date that was moved later, which are put back if they have not gone out.
      // One that has gone out is left exactly as it is.
      const knownRows = (
        await tx.stockSale.findMany({
          where: { showDate: { gte: toDbDate(lookBack) } },
          select: { id: true, key: true, place: true, status: true, flag: true, showDate: true, product: { select: { model: true } } },
        })
      ).filter((k) => fromDbDate(k.showDate) >= start || k.status !== "SENT");
      const known = new Map<string, KnownSale>(
        knownRows.map((k) => [k.key, { key: k.key, model: k.product.model, place: k.place as Place, status: k.status, flag: k.flag }]),
      );
      const rowId = new Map(knownRows.map((k) => [k.key, k.id]));

      const ids = [
        ...new Set([...wanted, ...knownRows.map((k) => ({ model: k.product.model }))].flatMap((w) => (w.model && byModel.has(w.model) ? [byModel.get(w.model)!.id] : []))),
      ];
      const current = await balancesFor(tx, ids);
      const balances = new Map<string, Record<Place, number>>();
      for (const p of products) {
        const b = current.get(p.id);
        if (b) balances.set(p.model, Object.fromEntries(PLACES.map((pl) => [pl, b[pl]])) as Record<Place, number>);
      }

      const plan: Plan = planDeduction(wanted, known, new Map(products.map((p) => [p.model, { costCents: p.costCents }])), balances);

      let sold = 0, sent = 0, putBack = 0, unsent = 0, flagged = 0;
      for (const c of plan.changes) {
        if (c.kind === "flag") {
          await tx.stockSale.update({ where: { key: c.key }, data: { flag: c.flag } });
          flagged++;
          continue;
        }
        const product = byModel.get(c.model)!;
        if (c.kind === "sell") {
          const data = {
            platform: c.line.platform, orderRef: c.line.orderRef, showDate: toDbDate(c.line.showDate), show: c.line.show,
            tracking: c.line.tracking, listing: c.line.stockNumber, productId: product.id, place: c.place, costCents: c.costCents,
            status: c.sent ? ("SENT" as const) : ("SOLD" as const), sentAt: c.sent ? new Date() : null, flag: c.flag,
          };
          const sale = c.reuse
            ? await tx.stockSale.update({ where: { key: c.key }, data, select: { id: true } })
            : await tx.stockSale.create({ data: { key: c.key, ...data }, select: { id: true } });
          rowId.set(c.key, sale.id);
          const note = `Sold · ${c.line.show} ${c.line.showDate} · order ${c.line.orderRef}`;
          const moves = [
            { place: c.place, qty: -1, note },
            { place: "WAITING" as const, qty: 1, note },
            ...(c.sent ? [{ place: "WAITING" as const, qty: -1, note: `Sent · box ${c.line.tracking}` }] : []),
          ];
          await tx.stockMove.createMany({
            data: moves.map((m, i) => ({
              productId: product.id, place: m.place, qty: m.qty, kind: i < 2 ? ("SOLD" as const) : ("SENT" as const),
              unitCostCents: c.costCents, saleId: sale.id, note: m.note, entryId: sale.id, byId: actorId,
            })),
          });
          sold++;
          if (c.sent) sent++;
          if (c.flag) flagged++;
        } else if (c.kind === "unsell") {
          const id = rowId.get(c.key)!;
          await tx.stockSale.update({ where: { id }, data: { status: "UNDONE", sentAt: null } });
          const note = "Put back: the reports no longer have this sale";
          await tx.stockMove.createMany({
            data: [
              { productId: product.id, place: "WAITING", qty: -1, kind: "SOLD", saleId: id, note, entryId: id, byId: actorId },
              { productId: product.id, place: c.place, qty: 1, kind: "SOLD", saleId: id, note, entryId: id, byId: actorId },
            ],
          });
          putBack++;
        } else if (c.kind === "send") {
          const id = rowId.get(c.key)!;
          await tx.stockSale.update({ where: { id }, data: { status: "SENT", sentAt: new Date() } });
          await tx.stockMove.create({ data: { productId: product.id, place: "WAITING", qty: -1, kind: "SENT", saleId: id, note: "Sent · its box was packed and closed", entryId: id, byId: actorId } });
          sent++;
        } else if (c.kind === "unsend") {
          const id = rowId.get(c.key)!;
          await tx.stockSale.update({ where: { id }, data: { status: "SOLD", sentAt: null } });
          await tx.stockMove.create({ data: { productId: product.id, place: "WAITING", qty: 1, kind: "SENT", saleId: id, note: "Back to waiting: its box was reopened", entryId: id, byId: actorId } });
          unsent++;
        }
      }

      if (sold + sent + putBack + unsent + flagged > 0) {
        await tx.auditLog.create({
          data: {
            entityType: "StockSale",
            entityId: "stock",
            action: "STOCK_UP_TO_DATE",
            actorId,
            summary: `Stock brought up to date with the reports and packing: ${sold} sold, ${sent} sent, ${putBack} put back, ${unsent} back to waiting, ${flagged} flagged.`,
          },
        });
      }
      return { on: true, startDate: start, sold, sent, putBack, unsent, flagged, unnamed: plan.unnamed, unknown: plan.unknown };
    },
    { timeout: 120_000, maxWait: 60_000 },
  );
}

/**
 * The same, for a page that is about to show stock: never fails the page. If
 * it cannot run, the page shows stock as it last stood.
 */
export async function bringStockUpToDateQuietly(actorId: string | null): Promise<StockUpToDate | null> {
  try {
    return await bringStockUpToDate(actorId);
  } catch (e) {
    console.error("bringStockUpToDate failed", e);
    return null;
  }
}

/** Set (or change) the first show day whose sales come off. Null turns it off. */
export async function setStartDate(actorId: string, date: DateISO | null): Promise<void> {
  const before = (await readStart()).inventoryStartDate;
  await prisma.$transaction([
    prisma.settings.update({ where: { id: "singleton" }, data: { inventoryStartDate: date ? toDbDate(date) : null } }),
    prisma.auditLog.create({
      data: {
        entityType: "Settings",
        entityId: "singleton",
        action: "INVENTORY_START_DATE",
        actorId,
        summary: date ? `Sales come off stock from the shows of ${date}.` : "Sales no longer come off stock.",
        before: { inventoryStartDate: before ? fromDbDate(before) : null },
        after: { inventoryStartDate: date },
      },
    }),
  ]);
}

/** What the sales page lists: watches sold and not yet sent, oldest first, and anything flagged. */
export async function getSalesView(today: DateISO) {
  const [waiting, flagged] = await Promise.all([
    prisma.stockSale.findMany({
      where: { status: "SOLD" },
      orderBy: [{ showDate: "asc" }, { orderRef: "asc" }],
      take: 500,
      select: { key: true, showDate: true, show: true, orderRef: true, tracking: true, listing: true, place: true, flag: true, product: { select: { model: true } } },
    }),
    prisma.stockSale.findMany({
      where: { flag: { not: "" }, showDate: { gte: toDbDate(addDays(today, -30)) } },
      orderBy: { showDate: "desc" },
      take: 200,
      select: { key: true, showDate: true, show: true, orderRef: true, tracking: true, listing: true, status: true, flag: true, product: { select: { model: true } } },
    }),
  ]);
  return {
    waiting: waiting.map((w) => ({ ...w, showDate: fromDbDate(w.showDate) })),
    flagged: flagged.map((f) => ({ ...f, showDate: fromDbDate(f.showDate) })),
  };
}

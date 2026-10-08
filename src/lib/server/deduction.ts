import "server-only";
import { prisma } from "@/lib/db";
import { addDays, fromDbDate, toDbDate, todayISO } from "@/lib/domain/dates";
import { planDeduction, wantedSales } from "@/lib/domain/deduction";
import type { BoxState, KnownSale, Plan, SaleLine, Stray, Wanted } from "@/lib/domain/deduction";
import { listingOfNote } from "@/lib/domain/imports/placeholders";
import { normaliseStockNumber } from "@/lib/domain/imports/tracking";
import { PLACES, catalogueSpelling } from "@/lib/domain/inventory";
import type { Place } from "@/lib/domain/inventory";
import type { DateISO } from "@/lib/domain/types";
import { balancesFor } from "./inventory";
import { latestBatchIds } from "./sales-data";
import { getSettings } from "./settings";

/**
 * Inventory, step 3: bringing stock up to date with the reports and packing.
 *
 * Runs after every upload of the day's reports and when the inventory pages
 * are opened (only if something has changed since the last run). Each run
 * compares what the reports and the boxes say with what stock already took off
 * (see `domain/deduction`), and writes only the difference — so it can run any
 * number of times, and two runs at once simply queue on the stock lock.
 *
 * Nothing new comes off until a director sets the start date: before the
 * opening count, sales never move stock.
 */

/**
 * How far back a run reads the reports for new sales. A sale still waiting to
 * ship is followed however old it is; only a correction to a report older than
 * this does not move stock by itself (a count puts it right).
 */
export const LOOK_BACK_DAYS = 14;

export interface StockUpToDate {
  /** False until a director sets the day sales start coming off. */
  on: boolean;
  startDate: DateISO | null;
  /** True when nothing had changed since the last run, so it did not run again. */
  skipped: boolean;
  sold: number;
  sent: number;
  putBack: number;
  unsent: number;
  flagged: number;
  unnamed: Wanted[];
  unknown: Wanted[];
  /** Watches scanned into a closed box that no sale in it accounts for. */
  strays: Stray[];
}

const NOTHING = { skipped: false, sold: 0, sent: 0, putBack: 0, unsent: 0, flagged: 0, unnamed: [], unknown: [], strays: [] };

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

/**
 * When anything a run reads last changed: an upload, a box packed or reopened,
 * a piece scanned, a model added, the start date. If it is the same as at the
 * last run on this server, running again would change nothing.
 */
async function changeMark(): Promise<string> {
  const [batch, box, scan, product, settings] = await Promise.all([
    prisma.importBatch.aggregate({ _max: { uploadedAt: true }, _count: true }),
    prisma.package.aggregate({ _max: { updatedAt: true } }),
    prisma.scanEvent.aggregate({ _max: { at: true } }),
    prisma.product.aggregate({ _max: { createdAt: true }, _count: true }),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { updatedAt: true } }),
  ]);
  return [
    batch._max.uploadedAt?.getTime(), batch._count, box._max.updatedAt?.getTime(), scan._max.at?.getTime(),
    product._max.createdAt?.getTime(), product._count, settings?.updatedAt.getTime(),
  ].join("|");
}
let lastMark: string | null = null;

/**
 * Bring stock up to date. Returns what it did, and what it could not do.
 *
 * `ifChanged` (for pages) skips the run when nothing it reads has changed since
 * the last one — so the count screen, which refreshes after every model, never
 * waits on it.
 */
export async function bringStockUpToDate(actorId: string | null, options: { ifChanged?: boolean } = {}): Promise<StockUpToDate> {
  // The mark first, then the start date: a start date saved in between is seen
  // by the next run rather than hidden behind a mark taken after it.
  const mark = await changeMark();
  // Read fresh, not from the per-request cache: a start date set a moment ago counts.
  const settings = await readStart();
  const start = settings.inventoryStartDate ? fromDbDate(settings.inventoryStartDate) : null;
  if (options.ifChanged && mark === lastMark) return { on: start !== null, startDate: start, ...NOTHING, skipped: true };

  const today = todayISO(settings.timezone);
  const lookBack = addDays(today, -LOOK_BACK_DAYS);
  // New sales are read from the start date (or the look-back, if later).
  const from = start && start > lookBack ? start : lookBack;
  // Reports can name tomorrow's date for a late night show; read a day ahead.
  const to = addDays(today, 1);

  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inventory-count')::bigint)`;

      // Every watch still waiting to ship is followed, however old — its box can close late.
      const oldestWaiting = await tx.stockSale.findFirst({ where: { status: "SOLD" }, orderBy: { showDate: "asc" }, select: { showDate: true } });
      const readFrom = oldestWaiting && fromDbDate(oldestWaiting.showDate) < from ? fromDbDate(oldestWaiting.showDate) : from;

      const batchIds = await latestBatchIds(readFrom, to);
      const rows = await tx.salesRecord.findMany({
        where: { batchId: { in: batchIds }, business: "WATCH", showDate: { gte: toDbDate(readFrom), lte: toDbDate(to) } },
        // A fixed order, so two lines nothing else tells apart (an eBay line id
        // Excel rounded) always get the same keys — here and in the morning numbers.
        orderBy: { id: "asc" },
        select: {
          platform: true, orderRef: true, lineRef: true, showDate: true, show: true, tracking: true, stockNumber: true, modelNumber: true, qty: true,
          batchId: true, batch: { select: { uploadedAt: true } },
        },
      });
      const lines: SaleLine[] = rows.map(({ batch, ...r }) => ({ ...r, showDate: fromDbDate(r.showDate), uploadedAt: batch.uploadedAt.getTime() }));

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
      const all = wantedSales(lines, boxes, (m) => byModel.has(m), catalogueSpelling(byModel.keys()));

      // What stock knows: the look-back window, every watch still waiting, and
      // any row for a key the reports name now (so a key is never created twice).
      const wantedKeys = all.wanted.map((w) => w.key);
      const knownRows = await tx.stockSale.findMany({
        where: { OR: [{ showDate: { gte: toDbDate(lookBack) } }, { status: "SOLD" }, { key: { in: wantedKeys } }] },
        select: { id: true, key: true, place: true, status: true, flag: true, tracking: true, showDate: true, product: { select: { model: true } } },
      });
      // A sent watch from before the start date (moved later) is left exactly as
      // it is: neither followed, nor flagged, nor taken off again.
      const leftAlone = new Set(
        knownRows.filter((k) => start && fromDbDate(k.showDate) < start && k.status === "SENT").map((k) => k.key),
      );
      const relevant = knownRows.filter((k) => !leftAlone.has(k.key));
      const known = new Map<string, KnownSale>(
        relevant.map((k) => [k.key, { key: k.key, model: k.product.model, place: k.place as Place, status: k.status, flag: k.flag, tracking: k.tracking }]),
      );
      const rowId = new Map(knownRows.map((k) => [k.key, k.id]));

      // New sales only from `from` on. Older lines are read only to follow watches
      // already known — and never from before the start date, whose sales are put
      // back if they have not gone out (the start date was moved later).
      const wanted = all.wanted.filter(
        (w) => !leftAlone.has(w.key) && (w.line.showDate >= from || (known.has(w.key) && (start === null || w.line.showDate >= start))),
      );

      const ids = [...new Set([...wanted.map((w) => w.model), ...relevant.map((k) => k.product.model)].flatMap((m) => (m && byModel.has(m) ? [byModel.get(m)!.id] : [])))];
      const current = await balancesFor(tx, ids);
      const balances = new Map<string, Record<Place, number>>();
      for (const p of products) {
        const b = current.get(p.id);
        if (b) balances.set(p.model, Object.fromEntries(PLACES.map((pl) => [pl, b[pl]])) as Record<Place, number>);
      }

      // Switched off: nothing new comes off and nothing is put back, but what
      // is already waiting still leaves when its box is packed.
      const plan: Plan = planDeduction(wanted, known, new Map(products.map((p) => [p.model, { costCents: p.costCents }])), balances, start === null);

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
          const sale = c.reuse || rowId.has(c.key)
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

      // A box number that arrived with a later upload.
      for (const w of wanted) {
        const k = known.get(w.key);
        if (k && k.status === "SOLD" && w.line.tracking && k.tracking !== w.line.tracking) {
          await tx.stockSale.update({ where: { key: w.key }, data: { tracking: w.line.tracking } });
        }
      }

      // Written when something changed — and also when nothing did but the last
      // run had failed, so the warning about it clears.
      const failedBefore = await tx.auditLog.findFirst({ where: { action: "STOCK_UP_TO_DATE_FAILED" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      const okBefore = await tx.auditLog.findFirst({ where: { action: "STOCK_UP_TO_DATE" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      const clearsFailure = failedBefore !== null && (okBefore === null || okBefore.createdAt < failedBefore.createdAt);
      if (sold + sent + putBack + unsent + flagged > 0 || clearsFailure) {
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
      return { on: start !== null, startDate: start, skipped: false, sold, sent, putBack, unsent, flagged, unnamed: plan.unnamed, unknown: plan.unknown, strays: all.strays };
    },
    { timeout: 120_000, maxWait: 60_000 },
  );
  lastMark = mark;
  return result;
}

/**
 * The same, for a page about to show stock or an upload that has just gone in:
 * never fails them. A failure is written to the audit log, where it can be
 * seen, and the caller is told so it can say so on screen.
 */
export async function bringStockUpToDateQuietly(actorId: string | null, options: { ifChanged?: boolean } = {}): Promise<StockUpToDate | null> {
  try {
    return await bringStockUpToDate(actorId, options);
  } catch (e) {
    console.error("bringStockUpToDate failed", e);
    try {
      await prisma.auditLog.create({
        data: {
          entityType: "StockSale",
          entityId: "stock",
          action: "STOCK_UP_TO_DATE_FAILED",
          actorId,
          summary: `Stock could not be brought up to date: ${e instanceof Error ? e.message.slice(0, 500) : "unknown error"}`,
        },
      });
    } catch {
      // The log is a courtesy; the page still shows.
    }
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
  const [waiting, flagged, failed] = await Promise.all([
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
    lastFailure(),
  ]);
  return {
    waiting: waiting.map((w) => ({ ...w, showDate: fromDbDate(w.showDate) })),
    flagged: flagged.map((f) => ({ ...f, showDate: fromDbDate(f.showDate) })),
    failed,
  };
}

/** The last time bringing stock up to date failed, if it has not succeeded since. */
export async function lastFailure(): Promise<{ at: Date; summary: string } | null> {
  const [fail, ok] = await Promise.all([
    prisma.auditLog.findFirst({ where: { action: "STOCK_UP_TO_DATE_FAILED" }, orderBy: { createdAt: "desc" }, select: { createdAt: true, summary: true } }),
    prisma.auditLog.findFirst({ where: { action: "STOCK_UP_TO_DATE" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  if (!fail || (ok && ok.createdAt > fail.createdAt)) return null;
  return { at: fail.createdAt, summary: fail.summary ?? "" };
}

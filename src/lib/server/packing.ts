import "server-only";
import { prisma } from "@/lib/db";
import { fromDbDate, toDbDate } from "@/lib/domain/dates";
import { matchTracking, normaliseScan, normaliseStockNumber } from "@/lib/domain/imports/tracking";
import type { DateISO } from "@/lib/domain/types";
import { packingDayISO } from "./settings";

/**
 * Reading a box for the packing screen.
 *
 * The screen holds one box at a time and every change comes back through an
 * action, so this is the one shape the whole flow speaks in.
 */

export interface PackingItemView {
  stockNumber: string;
  expected: number;
  scanned: number;
  /** Still to go in. Never negative — an over-scan is an override, not a debt. */
  outstanding: number;
}

export interface PackingBoxView {
  id: string;
  tracking: string;
  platform: "TIKTOK" | "EBAY";
  showDate: DateISO;
  buyer: string;
  shipToName: string;
  shipToState: string;
  status: "OPEN" | "CLOSED_COMPLETE" | "CLOSED_INCOMPLETE";
  isUnrecognised: boolean;
  items: PackingItemView[];
  totalExpected: number;
  totalScanned: number;
  /** Every line satisfied, and something actually in the box. */
  complete: boolean;
  closedByName: string | null;
  closedAt: Date | null;
}

const SELECT = {
  id: true,
  trackingNumber: true,
  platform: true,
  showDate: true,
  buyer: true,
  shipToName: true,
  shipToState: true,
  status: true,
  isUnrecognised: true,
  closedAt: true,
  closedBy: { select: { name: true } },
  items: {
    select: { stockNumber: true, expectedQty: true, scannedQty: true },
    orderBy: { stockNumber: "asc" as const },
  },
} as const;

type Row = {
  id: string;
  trackingNumber: string;
  platform: "TIKTOK" | "EBAY";
  showDate: Date;
  buyer: string;
  shipToName: string;
  shipToState: string;
  status: "OPEN" | "CLOSED_COMPLETE" | "CLOSED_INCOMPLETE";
  isUnrecognised: boolean;
  closedAt: Date | null;
  closedBy: { name: string } | null;
  items: { stockNumber: string; expectedQty: number; scannedQty: number }[];
};

export function toBoxView(row: Row): PackingBoxView {
  const items = row.items.map((i) => ({
    stockNumber: i.stockNumber,
    expected: i.expectedQty,
    scanned: i.scannedQty,
    outstanding: Math.max(0, i.expectedQty - i.scannedQty),
  }));

  return {
    id: row.id,
    tracking: row.trackingNumber,
    platform: row.platform,
    showDate: fromDbDate(row.showDate),
    buyer: row.buyer,
    shipToName: row.shipToName,
    shipToState: row.shipToState,
    status: row.status,
    isUnrecognised: row.isUnrecognised,
    items,
    totalExpected: items.reduce((n, i) => n + i.expected, 0),
    totalScanned: items.reduce((n, i) => n + i.scanned, 0),
    // Something has to be in it: an unrecognised box starts with no lines at
    // all, and "nothing outstanding" is true of an empty box too.
    complete: items.length > 0 && items.every((i) => i.outstanding === 0),
    closedByName: row.closedBy?.name ?? null,
    closedAt: row.closedAt,
  };
}

export async function getBoxById(id: string): Promise<PackingBoxView | null> {
  const row = await prisma.package.findUnique({ where: { id }, select: SELECT });
  return row ? toBoxView(row as Row) : null;
}

/**
 * Finds the box a scanned label refers to.
 *
 * The scanner returns the whole routing barcode, not the tracking number, so
 * the match is by suffix — see `lib/domain/imports/tracking`. Candidates are
 * narrowed in the database by the last few digits first, because loading every
 * tracking number ever shipped to match one scan would get slower every day.
 */
export async function findBoxByScan(rawScan: string): Promise<PackingBoxView | null> {
  const scan = normaliseScan(rawScan);
  if (scan.length < 8) return null;

  const tail = scan.slice(-8);
  const candidates = await prisma.package.findMany({
    where: { trackingNumber: { endsWith: tail } },
    select: SELECT,
  });
  if (candidates.length === 0) return null;

  const match = matchTracking(
    scan,
    candidates.map((c) => c.trackingNumber),
  );
  if (match.status !== "matched") return null;

  const row = candidates.find((c) => c.trackingNumber === match.tracking);
  return row ? toBoxView(row as Row) : null;
}

/* ==========================================================================
   The scan flow itself.

   These take a user id rather than reading the session, so the whole flow can
   be exercised against a real database without a request — the same shape as
   `runImport`. The server actions are the thin layer that decides who is
   allowed to call them.
   ========================================================================== */

export type ScanOutcome =
  /** The box is open and this is its current state. */
  | { kind: "box"; box: PackingBoxView; message?: string }
  /** Scanned a label for a box that has already gone. Not an error. */
  | { kind: "alreadyPacked"; box: PackingBoxView }
  /** No uploaded order has this tracking number. Packable anyway. */
  | { kind: "unknownLabel"; tracking: string }
  /**
   * The scan was rejected. The box is unchanged.
   *
   * `stockNumber` is set when the refusal is about a specific watch, and it is
   * what the screen offers to add anyway. Carried as a field rather than left to
   * be read back out of `message`: the screen used to parse the sentence, so
   * rewording a refusal would have quietly removed the packer's only way to
   * record a watch that really is in the box.
   */
  | { kind: "refused"; box: PackingBoxView; message: string; stockNumber?: string }
  | { kind: "error"; message: string };

/** Re-reads the box and wraps it, after something changed it. */
async function reload(packageId: string, message?: string): Promise<ScanOutcome> {
  const box = await getBoxById(packageId);
  return box ? { kind: "box", box, message } : { kind: "error", message: "Lost the box." };
}

/**
 * Opens the box a label belongs to.
 *
 * Three answers, and only one is a problem: known and open, known and already
 * gone, or not in the system at all. A label for a box that has shipped gets
 * "already packed" rather than an error — duplicate labels are normal, and
 * telling her the truth in two words stops her hunting for a fault that is not
 * there.
 */
export async function openBoxByScan(userId: string, rawScan: string): Promise<ScanOutcome> {
  const scan = normaliseScan(rawScan);
  if (scan.length < 8) return { kind: "error", message: "That does not look like a shipping label." };

  const box = await findBoxByScan(scan);
  if (!box) return { kind: "unknownLabel", tracking: scan };
  if (box.status !== "OPEN") return { kind: "alreadyPacked", box };

  await prisma.scanEvent.create({
    data: { packageId: box.id, userId, kind: "LABEL", rawScan: scan },
  });
  return { kind: "box", box };
}

/**
 * Starts a box for a label that is in no uploaded file.
 *
 * A deliberate second step rather than something that happens on the scan: an
 * unrecognised label usually means the morning's report has not been uploaded,
 * and quietly inventing a box would hide that.
 */
export async function createUnknownBox(userId: string, rawScan: string): Promise<ScanOutcome> {
  const tracking = normaliseScan(rawScan);
  if (tracking.length < 8) {
    return { kind: "error", message: "That does not look like a shipping label." };
  }

  const existing = await findBoxByScan(tracking);
  if (existing) {
    return existing.status === "OPEN"
      ? { kind: "box", box: existing }
      : { kind: "alreadyPacked", box: existing };
  }

  /*
    The day being packed, not the day it is here.

    This used to take UTC midnight of "now". The packing screen and the shipping
    log both work on yesterday in the business zone, so a box created that way
    landed on a date nobody was looking at — and after 20:00 Eastern, UTC has
    already rolled over, so it landed on tomorrow. Being unrecognised is the one
    thing that puts a box in front of the director to reconcile, and it was
    filing them where she would not see them.
  */
  const showDate = toDbDate(await packingDayISO());

  const created = await prisma.package.create({
    data: {
      trackingNumber: tracking,
      // Nothing anywhere says which marketplace it came from; the director
      // reconciles it either way.
      platform: "TIKTOK",
      showDate,
      isUnrecognised: true,
      buyer: "",
    },
    select: { id: true },
  });

  await prisma.scanEvent.create({
    data: {
      packageId: created.id,
      userId,
      kind: "LABEL",
      rawScan: tracking,
      note: "Label was not in any uploaded report",
    },
  });

  return reload(created.id, "Not in any report — scan what is actually in the box.");
}

/**
 * Puts one watch in the box.
 *
 * The increment is one conditional statement rather than a read then a write:
 * two packers can be working the same stack, and read-then-write lets both see
 * "2 of 3" and both write 3.
 */
export async function packItem(
  userId: string,
  packageId: string,
  rawScan: string,
): Promise<ScanOutcome> {
  const stockNumber = normaliseStockNumber(rawScan);
  if (stockNumber === "") return { kind: "error", message: "Nothing was scanned." };

  const box = await getBoxById(packageId);
  if (!box) return { kind: "error", message: "That box no longer exists." };
  if (box.status !== "OPEN") return { kind: "alreadyPacked", box };

  // An unrecognised box has no list to check against, so what she scans *is*
  // the record of what went in it.
  if (box.isUnrecognised) {
    await prisma.$transaction([
      prisma.packageItem.upsert({
        where: { packageId_stockNumber: { packageId, stockNumber } },
        create: { packageId, stockNumber, expectedQty: 0, scannedQty: 1 },
        update: { scannedQty: { increment: 1 } },
      }),
      prisma.scanEvent.create({
        data: { packageId, userId, kind: "ITEM_ACCEPTED", stockNumber, rawScan },
      }),
    ]);
    return reload(packageId);
  }

  const line = box.items.find((i) => i.stockNumber === stockNumber);
  if (!line) {
    await prisma.scanEvent.create({
      data: { packageId, userId, kind: "ITEM_REFUSED", stockNumber, rawScan, note: "Not in this box" },
    });
    return {
      kind: "refused",
      box,
      message: `${stockNumber} is not in this box.`,
      stockNumber,
    };
  }

  const claimed = await prisma.$queryRaw<{ scannedQty: number }[]>`
    UPDATE "PackageItem"
       SET "scannedQty" = "scannedQty" + 1
     WHERE "packageId" = ${packageId}
       AND "stockNumber" = ${stockNumber}
       AND "scannedQty" < "expectedQty"
    RETURNING "scannedQty"
  `;

  if (claimed.length === 0) {
    await prisma.scanEvent.create({
      data: {
        packageId,
        userId,
        kind: "ITEM_REFUSED",
        stockNumber,
        rawScan,
        note: `All ${line.expected} already scanned`,
      },
    });
    /*
      Offered here too, and it was not before.

      "All three are already in the box" was a dead end: if a fourth one really
      was in the parcel, there was no way to record it at all. It is the same
      situation as an unlisted watch — the report says no and the box says yes —
      and the answer is the same. Adding it takes the scanned count past the
      expected one, which is what marks the box incomplete and puts it in front
      of the director.
    */
    return {
      kind: "refused",
      box,
      message: `All ${line.expected} of ${stockNumber} are already in the box.`,
      stockNumber,
    };
  }

  await prisma.scanEvent.create({
    data: { packageId, userId, kind: "ITEM_ACCEPTED", stockNumber, rawScan },
  });
  return reload(packageId);
}

/**
 * Records a watch that is genuinely in the box but not on the list.
 *
 * The deliberate half of the refusal. Nine times out of ten an unexpected scan
 * is the wrong watch in her hand, which is why it is refused by default — but
 * when the data is wrong and the watch belongs, the physical box wins. Doing so
 * marks the box incomplete, so it goes in front of the director rather than
 * passing unnoticed.
 */
export async function overrideItem(
  userId: string,
  packageId: string,
  stockNumber: string,
): Promise<ScanOutcome> {
  const stock = normaliseStockNumber(stockNumber);
  if (stock === "") return { kind: "error", message: "Nothing to add." };

  const box = await getBoxById(packageId);
  if (!box) return { kind: "error", message: "That box no longer exists." };
  if (box.status !== "OPEN") return { kind: "alreadyPacked", box };

  await prisma.$transaction([
    prisma.packageItem.upsert({
      where: { packageId_stockNumber: { packageId, stockNumber: stock } },
      create: { packageId, stockNumber: stock, expectedQty: 0, scannedQty: 1 },
      update: { scannedQty: { increment: 1 } },
    }),
    prisma.scanEvent.create({
      data: { packageId, userId, kind: "ITEM_OVERRIDE", stockNumber: stock, note: "Added against the report" },
    }),
  ]);

  return reload(packageId, `${stock} added. This box will close as incomplete.`);
}

/**
 * Marks the box shipped, for everyone.
 *
 * `force` is the subordinate button: it closes a box that is short, or one that
 * had something added against the report, and stamps it INCOMPLETE permanently.
 * No reason is required — the system already knows exactly what was missing —
 * but a note is offered.
 */
export async function sealBox(
  userId: string,
  packageId: string,
  force: boolean,
  note?: string,
): Promise<ScanOutcome> {
  const box = await getBoxById(packageId);
  if (!box) return { kind: "error", message: "That box no longer exists." };
  if (box.status !== "OPEN") return { kind: "alreadyPacked", box };

  // Anything over the expected count means the report and the box disagreed and
  // the box won. That is a discrepancy even though nothing is missing.
  //
  // Except on a box that was in no report at all, where every watch is "over"
  // by definition and there is nothing for it to disagree with. Its contents
  // are simply what she scanned, which is the truth; `isUnrecognised` is what
  // puts it in front of the director, not an incomplete stamp it did not earn.
  const over = !box.isUnrecognised && box.items.some((i) => i.scanned > i.expected);
  const complete = box.complete && !over;

  if (!complete && !force) {
    return {
      kind: "refused",
      box,
      message: over
        ? "Something was added that is not on the report. Close it incomplete to record that."
        : "Not everything is in the box yet.",
    };
  }

  await prisma.$transaction([
    prisma.package.update({
      where: { id: packageId },
      data: {
        status: complete ? "CLOSED_COMPLETE" : "CLOSED_INCOMPLETE",
        closedById: userId,
        closedAt: new Date(),
      },
    }),
    prisma.scanEvent.create({
      data: {
        packageId,
        userId,
        kind: complete ? "CLOSE_COMPLETE" : "CLOSE_INCOMPLETE",
        note: note?.trim() || null,
      },
    }),
  ]);

  return reload(packageId, complete ? "Closed." : "Closed, marked incomplete.");
}

/**
 * Puts a closed box back.
 *
 * The director's job, not a packer's: closing is meant to be final, and undoing
 * it is a correction somebody should be accountable for. The scan history is
 * untouched — reopening adds a row, it never removes one.
 */
export async function unsealBox(
  userId: string,
  packageId: string,
  reason: string,
): Promise<ScanOutcome> {
  if (reason.trim().length < 3) {
    return { kind: "error", message: "Say why the box is being reopened." };
  }

  const box = await getBoxById(packageId);
  if (!box) return { kind: "error", message: "That box no longer exists." };
  if (box.status === "OPEN") return { kind: "box", box, message: "That box is already open." };

  await prisma.$transaction([
    prisma.package.update({
      where: { id: packageId },
      data: { status: "OPEN", closedById: null, closedAt: null },
    }),
    prisma.scanEvent.create({
      data: { packageId, userId, kind: "REOPEN", note: reason.trim() },
    }),
  ]);

  return reload(packageId, "Reopened.");
}

export interface DayCounters {
  dateISO: DateISO;
  total: number;
  sent: number;
  incomplete: number;
  unrecognised: number;
}

/**
 * What one person did on one day.
 *
 * First and last scan rather than login times: people sign in once and stay
 * signed in for weeks, so a login timestamp says nothing about a shift. The
 * first and last box somebody closed brackets when they were actually working,
 * which is a more honest measure anyway — it reflects activity, not presence.
 *
 * This is not a timesheet and must not be read as one. It knows nothing about
 * breaks or anything else they did. The clock remains the payroll record.
 */
export interface PackerDay {
  userId: string;
  name: string;
  boxes: number;
  items: number;
  firstScan: Date | null;
  lastScan: Date | null;
}

export async function getPackerDays(showDate: Date): Promise<PackerDay[]> {
  const [closed, items, bounds] = await Promise.all([
    prisma.package.groupBy({
      by: ["closedById"],
      where: { showDate, closedById: { not: null } },
      _count: { _all: true },
    }),
    prisma.scanEvent.groupBy({
      by: ["userId"],
      where: { package: { showDate }, kind: "ITEM_ACCEPTED" },
      _count: { _all: true },
    }),
    prisma.scanEvent.groupBy({
      by: ["userId"],
      where: { package: { showDate } },
      _min: { at: true },
      _max: { at: true },
    }),
  ]);

  const ids = new Set<string>([
    ...closed.map((c) => c.closedById!).filter(Boolean),
    ...items.map((i) => i.userId),
    ...bounds.map((b) => b.userId),
  ]);
  if (ids.size === 0) return [];

  const people = await prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const boxesOf = new Map(closed.map((c) => [c.closedById!, c._count._all]));
  const itemsOf = new Map(items.map((i) => [i.userId, i._count._all]));
  const boundsOf = new Map(bounds.map((b) => [b.userId, b]));

  return [...ids]
    .map((userId) => ({
      userId,
      name: nameOf.get(userId) ?? "Somebody who has since been removed",
      boxes: boxesOf.get(userId) ?? 0,
      items: itemsOf.get(userId) ?? 0,
      firstScan: boundsOf.get(userId)?._min.at ?? null,
      lastScan: boundsOf.get(userId)?._max.at ?? null,
    }))
    .sort((a, b) => b.boxes - a.boxes || a.name.localeCompare(b.name));
}

export interface BoxSummary {
  id: string;
  tracking: string;
  buyer: string;
  status: "OPEN" | "CLOSED_COMPLETE" | "CLOSED_INCOMPLETE";
  isUnrecognised: boolean;
  closedByName: string | null;
  closedAt: Date | null;
  expected: number;
  scanned: number;
}

async function listBoxes(where: object): Promise<BoxSummary[]> {
  const rows = await prisma.package.findMany({
    where,
    orderBy: { closedAt: "desc" },
    select: {
      id: true,
      trackingNumber: true,
      buyer: true,
      status: true,
      isUnrecognised: true,
      closedAt: true,
      closedBy: { select: { name: true } },
      items: { select: { expectedQty: true, scannedQty: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    tracking: r.trackingNumber,
    buyer: r.buyer,
    status: r.status,
    isUnrecognised: r.isUnrecognised,
    closedByName: r.closedBy?.name ?? null,
    closedAt: r.closedAt,
    expected: r.items.reduce((n, i) => n + i.expectedQty, 0),
    scanned: r.items.reduce((n, i) => n + i.scannedQty, 0),
  }));
}

/** Boxes that went out short, or with something added against the report. */
export function listIncompleteBoxes(showDate: Date): Promise<BoxSummary[]> {
  return listBoxes({ showDate, status: "CLOSED_INCOMPLETE" });
}

/** Labels that were in no uploaded report. The reconcile queue. */
export function listUnrecognisedBoxes(showDate: Date): Promise<BoxSummary[]> {
  return listBoxes({ showDate, isUnrecognised: true });
}

/** Every box one person closed on one day, newest first. */
export async function getPersonDay(
  userId: string,
  showDate: Date,
): Promise<{ name: string; boxes: BoxSummary[]; items: number } | null> {
  const person = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true },
  });
  if (!person) return null;

  const [boxes, items] = await Promise.all([
    listBoxes({ showDate, closedById: userId }),
    prisma.scanEvent.count({
      where: { userId, kind: "ITEM_ACCEPTED", package: { showDate } },
    }),
  ]);

  return { name: person.name, boxes, items };
}

export interface ScanRow {
  at: Date;
  kind: string;
  stockNumber: string | null;
  note: string | null;
  byName: string;
}

/**
 * Every scan that went into one box, oldest first.
 *
 * The dispute record. It establishes that a model was scanned into a specific
 * box, by a named person, at a known moment — and that another was refused.
 * What it cannot do is tell two watches of the same model apart, because the
 * barcode is the model.
 */
export async function getBoxScans(packageId: string): Promise<ScanRow[]> {
  const rows = await prisma.scanEvent.findMany({
    where: { packageId },
    orderBy: { at: "asc" },
    select: {
      at: true,
      kind: true,
      stockNumber: true,
      note: true,
      user: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    at: r.at,
    kind: r.kind,
    stockNumber: r.stockNumber,
    note: r.note,
    byName: r.user.name,
  }));
}

/** Boxes sent of the day's total — the headline on the log. */
export async function getDayCounters(showDate: Date, dateISO: DateISO): Promise<DayCounters> {
  const rows = await prisma.package.groupBy({
    by: ["status", "isUnrecognised"],
    where: { showDate },
    _count: { _all: true },
  });

  let total = 0;
  let sent = 0;
  let incomplete = 0;
  let unrecognised = 0;
  for (const row of rows) {
    total += row._count._all;
    if (row.status !== "OPEN") sent += row._count._all;
    if (row.status === "CLOSED_INCOMPLETE") incomplete += row._count._all;
    if (row.isUnrecognised) unrecognised += row._count._all;
  }

  return { dateISO, total, sent, incomplete, unrecognised };
}

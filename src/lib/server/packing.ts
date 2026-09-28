import "server-only";
import { prisma } from "@/lib/db";
import { fromDbDate, toDbDate } from "@/lib/domain/dates";
import type { Business } from "@/lib/domain/business";
import {
  decidePlaceholderScan,
  isPlaceholderStock,
  listingOfNote,
  placeholderNote,
} from "@/lib/domain/imports/placeholders";
import {
  describeTracking,
  looksLikeShippingLabel,
  matchTracking,
  normaliseScan,
  normaliseStockNumber,
} from "@/lib/domain/imports/tracking";
import type { DateISO } from "@/lib/domain/types";
import { packingDayISO } from "./settings";

/**
 * Reading a box for the packing screen.
 *
 * The screen holds one box at a time and every change comes back through an
 * action, so this is the one shape the whole flow speaks in.
 */

/**
 * Where a box has got to.
 *
 * `CLOSED_UNVERIFIED` is a box that went out without being scanned here — a day
 * marked sent in bulk. It is a separate state on purpose: it must not be
 * counted as verified, and it is not a discrepancy either.
 */
export type BoxStatus = "OPEN" | "CLOSED_COMPLETE" | "CLOSED_INCOMPLETE" | "CLOSED_UNVERIFIED";

export interface PackingItemView {
  stockNumber: string;
  expected: number;
  scanned: number;
  /** Still to go in. Never negative — an over-scan is an override, not a debt. */
  outstanding: number;
  /**
   * The line is a placeholder listing ("LGD - As seen on screen…"), not a
   * stock number. Nothing on the piece carries it, so the packer scans the
   * piece's own tag instead. See `domain/imports/placeholders`.
   */
  placeholder: boolean;
  /** The real tags recorded against a placeholder line, in the order scanned. */
  pieces: string[];
}

export interface PackingBoxView {
  id: string;
  tracking: string;
  /** Watches or diamonds — for the words on the screen, not for any rule. */
  business: Business;
  platform: "TIKTOK" | "EBAY";
  showDate: DateISO;
  buyer: string;
  shipToName: string;
  shipToState: string;
  status: BoxStatus;
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
  business: true,
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
  // Which real piece went in against each placeholder line. Nearly always an
  // empty list: only a box sold under a placeholder listing has any.
  scans: {
    where: { kind: "ITEM_PLACEHOLDER" as const },
    select: { stockNumber: true, note: true },
    orderBy: { at: "asc" as const },
  },
} as const;

type Row = {
  id: string;
  trackingNumber: string;
  business: Business;
  platform: "TIKTOK" | "EBAY";
  showDate: Date;
  buyer: string;
  shipToName: string;
  shipToState: string;
  status: BoxStatus;
  isUnrecognised: boolean;
  closedAt: Date | null;
  closedBy: { name: string } | null;
  items: { stockNumber: string; expectedQty: number; scannedQty: number }[];
  scans: { stockNumber: string | null; note: string | null }[];
};

export function toBoxView(row: Row): PackingBoxView {
  const items = row.items.map((i) => ({
    stockNumber: i.stockNumber,
    expected: i.expectedQty,
    scanned: i.scannedQty,
    outstanding: Math.max(0, i.expectedQty - i.scannedQty),
    placeholder: isPlaceholderStock(i.stockNumber),
    pieces: row.scans
      .filter((s) => listingOfNote(s.note) === i.stockNumber && s.stockNumber)
      .map((s) => s.stockNumber as string),
  }));

  return {
    id: row.id,
    // The label she is holding, not the cell the marketplace wrote.
    tracking: describeTracking(row.trackingNumber),
    business: row.business,
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
async function lookUpScan(rawScan: string): Promise<ScanLookup> {
  const scan = normaliseScan(rawScan);
  if (scan.length < 8) return { kind: "none" };

  /*
    Narrowed by "contains", not "ends with".

    A two-parcel order's cell holds both labels — `(94…438,94…593)` — so the
    first label's digits are in the middle of the string and the whole thing
    ends in a bracket. Asking the database for cells that end with the scan's
    tail found neither label, and the packer was told her parcel was in no
    report. `matchTracking` still decides; this only has to not rule the box
    out before it gets there.
  */
  const tail = scan.slice(-8);
  const candidates = await prisma.package.findMany({
    where: { trackingNumber: { contains: tail } },
    select: SELECT,
  });
  if (candidates.length === 0) return { kind: "none" };

  const match = matchTracking(
    scan,
    candidates.map((c) => c.trackingNumber),
  );
  if (match.status === "ambiguous") return { kind: "ambiguous", boxes: match.candidates };
  if (match.status !== "matched") return { kind: "none" };

  const row = candidates.find((c) => c.trackingNumber === match.tracking);
  return row ? { kind: "box", box: toBoxView(row as Row) } : { kind: "none" };
}

/**
 * The box a scan means, or why there isn't one.
 *
 * Ambiguous is its own answer and not merely "not found". A label on two boxes
 * is a question for the director; telling the packer it is in no report would
 * send her to open an unrecognised box for a parcel the report knows perfectly
 * well, leaving the real box open and short with nothing tying the two
 * together.
 */
type ScanLookup =
  | { kind: "box"; box: PackingBoxView }
  | { kind: "ambiguous"; boxes: string[] }
  | { kind: "none" };

/** The old shape, for the paths that only care whether there is one box. */
export async function findBoxByScan(rawScan: string): Promise<PackingBoxView | null> {
  const found = await lookUpScan(rawScan);
  return found.kind === "box" ? found.box : null;
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
  | {
      kind: "refused";
      box: PackingBoxView;
      message: string;
      stockNumber?: string;
      /** What was scanned was a shipping label, so the screen can offer to open that box. */
      label?: string;
      /** Matched no watch on any report — a misread, not something to add to the box. */
      unreadable?: boolean;
    }
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
/**
 * A label that is on two boxes.
 *
 * Refused rather than guessed at, and deliberately not offered as an unknown
 * box: the parcel is in the report twice over, and packing it into a new one
 * would leave both of the real boxes open and short.
 */
function ambiguousLabel(boxes: readonly string[]): ScanOutcome {
  return {
    kind: "error",
    message:
      `That label is on ${boxes.length} boxes (${boxes.map(describeTracking).join(", ")}). ` +
      `Put the parcel aside and ask the director which order it belongs to — packing it into a ` +
      `new box would leave both of those open and short.`,
  };
}

export async function openBoxByScan(userId: string, rawScan: string): Promise<ScanOutcome> {
  const scan = normaliseScan(rawScan);
  if (scan.length < 8) return { kind: "error", message: "That does not look like a shipping label." };

  const found = await lookUpScan(scan);
  if (found.kind === "ambiguous") return ambiguousLabel(found.boxes);
  if (found.kind === "none") return { kind: "unknownLabel", tracking: scan };
  const box = found.box;
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

  const found = await lookUpScan(tracking);
  if (found.kind === "ambiguous") return ambiguousLabel(found.boxes);
  if (found.kind === "box") {
    return found.box.status === "OPEN"
      ? { kind: "box", box: found.box }
      : { kind: "alreadyPacked", box: found.box };
  }

  /*
    A box can exist under this exact label without the lookup above finding it.

    The tracking number is unique, and the match is by suffix rather than by
    equality, so an oddly shaped value — a long scan kept verbatim from a
    different symbology — can fail to find itself. Creating it then hits the
    unique index and throws out of the server action, which reaches the packer
    as nothing at all. Caught below and answered with the box that was already
    there.
  */

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

  let created: { id: string };
  try {
    created = await prisma.package.create({
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
  } catch {
    const already = await prisma.package.findUnique({
      where: { trackingNumber: tracking },
      select: SELECT,
    });
    if (!already) return { kind: "error", message: "That box could not be started. Try the scan again." };
    const box = toBoxView(already as Row);
    return box.status === "OPEN" ? { kind: "box", box } : { kind: "alreadyPacked", box };
  }

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

  /*
    The box on screen is closed, and a shipping label was scanned.

    That is the next parcel, so it opens it. It used to be answered "already
    packed" and thrown away — the packer closed a box, scanned the next label,
    was told the box she had just finished was already packed, and had to scan
    the same label a second time to get anywhere. One wasted scan per parcel,
    and a message about the wrong box.

    A watch scanned into a closed box is still "already packed": nothing can go
    into a box that has gone.
  */
  if (box.status !== "OPEN") {
    if (looksLikeShippingLabel(rawScan)) return openBoxByScan(userId, rawScan);
    return { kind: "alreadyPacked", box };
  }

  /*
    A shipping label, scanned while a box is open.

    The screen reads every scan as a watch while a box is open. On 09/10–11 that
    produced 36 of the 75 refusals: the next parcel's label scanned before this
    box was closed, or this box's own label scanned a second time. Each was
    logged as a watch "not in this box" — which it was not — and made the record
    look like the floor catching wrong watches all morning.

    So a label is answered as a label. Nothing goes in the box and nothing is
    written to the scan log, because no watch was involved. It is checked before
    the unrecognised-box branch too: that box accepts anything, and on 09/11 it
    accepted a second shipping label as a watch, twice.
  */
  if (looksLikeShippingLabel(rawScan)) {
    const labelled = await findBoxByScan(rawScan);
    if (labelled?.id === box.id) {
      return {
        kind: "box",
        box,
        message: "That is this box's own label — it is already open. Scan the watches.",
      };
    }
    return {
      kind: "refused",
      box,
      label: rawScan.trim(),
      message: labelled
        ? labelled.status === "OPEN"
          ? `That is the label for another box (${labelled.tracking}). Finish this box first — close it or put it down — then scan that label.`
          : `That is the label for a box that is already packed (${labelled.tracking}). Finish this box first.`
        : "That is a shipping label, not a watch. Finish this box first — close it or put it down — then scan the label again.",
    };
  }

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
    // A box sold under a placeholder listing expects "a piece", not a number,
    // so the tag on the piece is the answer — if it passes the checks.
    const placeholder = await packPlaceholder(userId, box, stockNumber, rawScan);
    if (placeholder) return placeholder;

    /*
      Not in this box — or not a watch at all.

      21 of the 09/10–11 refusals were misreads: 69027 coming through as "WYZ."
      or "69Z.", 48389 as "4838", a retail UPC. Telling the packer that "watch" is
      not in this box sends her looking for a wrong watch in her hand when the
      right one is there and simply did not scan. A stock number that is on no
      report ever loaded is almost always that, so it says so — and does not
      offer to add it, because "WYZ." is not something to record as packed.

      Only lines a report asked for count as known. Lines added against a report
      carry an expected quantity of zero, and one of those on 09/11 was a
      shipping label scanned in as a watch.

      Still logged, since a scan was turned away, but with its own note so the
      record can tell a misread from a caught mistake.
    */
    const onAReport = await prisma.packageItem.findFirst({
      where: { stockNumber, expectedQty: { gt: 0 } },
      select: { id: true },
    });
    const unreadable = onAReport === null;

    await prisma.scanEvent.create({
      data: {
        packageId,
        userId,
        kind: "ITEM_REFUSED",
        stockNumber,
        rawScan,
        note: unreadable ? "Not a stock number on any report — probably a misread" : "Not in this box",
      },
    });
    return {
      kind: "refused",
      box,
      message: unreadable
        ? `Could not match "${stockNumber}" to any watch on a report — probably a misread. Scan it again, or type the stock number and press Enter.`
        : `${stockNumber} is not in this box.`,
      stockNumber,
      unreadable,
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
 * The scan kinds that mean something went into a box.
 *
 * Counted wherever the day's items are totted up — the packer's tally, the
 * shipping workbook. A piece recorded against a placeholder listing went in the
 * box as surely as one that matched its order, and leaving it out would make
 * whoever packed the diamond placeholders look slower than they were.
 */
export const PACKED_ITEM_KINDS = ["ITEM_ACCEPTED", "ITEM_PLACEHOLDER"] as const;

/**
 * Puts a piece in a box that was sold under a placeholder listing.
 *
 * Null when the box has no placeholder still waiting, which is nearly every
 * box, and those pay for none of the lookups below. Otherwise the tag is
 * checked against the rest of the day before it is recorded — see
 * `decidePlaceholderScan` for why each check exists — and the increment is the
 * same conditional statement `packItem` uses, so two packers cannot both fill
 * the last placeholder in a box.
 */
async function packPlaceholder(
  userId: string,
  box: PackingBoxView,
  stockNumber: string,
  rawScan: string,
): Promise<ScanOutcome | null> {
  if (!box.items.some((i) => i.placeholder && i.outstanding > 0)) return null;

  // "That day" is the box's own show date: the day whose orders a mix-up
  // could come from, since those are the parcels on the table together.
  const showDate = toDbDate(box.showDate);
  const [onAnother, elsewhere] = await Promise.all([
    prisma.packageItem.findFirst({
      where: { stockNumber, expectedQty: { gt: 0 }, packageId: { not: box.id }, package: { showDate } },
      select: { package: { select: { trackingNumber: true } } },
    }),
    prisma.scanEvent.findFirst({
      where: { kind: "ITEM_PLACEHOLDER", stockNumber, packageId: { not: box.id }, package: { showDate } },
      select: { package: { select: { trackingNumber: true } } },
    }),
  ]);

  const decision = decidePlaceholderScan({
    scanned: stockNumber,
    lines: box.items,
    filledHere: box.items.flatMap((i) => i.pieces),
    onAnotherOrder: onAnother?.package.trackingNumber ?? null,
    packedElsewhere: elsewhere?.package.trackingNumber ?? null,
  });

  if (decision.kind === "none") return null;

  if (decision.kind === "refuse") {
    const refusal = {
      notATag: {
        note: "Placeholder: not a tag — probably a misread",
        message: `Could not read "${stockNumber}" as the tag on a piece — probably a misread. Scan the tag again, or type the number and press Enter.`,
      },
      alreadyInThisBox: {
        note: "Placeholder: already recorded in this box",
        message: `${stockNumber} is already recorded in this box. Each piece goes in once.`,
      },
      onAnotherOrder: {
        note: `Placeholder: on another customer's order (${decision.otherBox})`,
        message: `${stockNumber} is on another customer's order (box ${decision.otherBox}). It does not go in this box.`,
      },
      packedElsewhere: {
        note: `Placeholder: already packed into ${decision.otherBox}`,
        message: `${stockNumber} was already packed into box ${decision.otherBox} as that customer's piece. A piece only ships once.`,
      },
    }[decision.reason];

    await prisma.scanEvent.create({
      data: { packageId: box.id, userId, kind: "ITEM_REFUSED", stockNumber, rawScan, note: refusal.note },
    });
    return {
      kind: "refused",
      box,
      message: refusal.message,
      // A misread is not something to add, and nor is a piece already in this
      // box. The other two are the same as any "not in this box": the report
      // says no, and if the piece really belongs, adding it closes the box
      // incomplete in front of the director.
      stockNumber:
        decision.reason === "notATag" || decision.reason === "alreadyInThisBox" ? undefined : stockNumber,
      unreadable: decision.reason === "notATag" ? true : undefined,
    };
  }

  const claimed = await prisma.$queryRaw<{ scannedQty: number }[]>`
    UPDATE "PackageItem"
       SET "scannedQty" = "scannedQty" + 1
     WHERE "packageId" = ${box.id}
       AND "stockNumber" = ${decision.listing}
       AND "scannedQty" < "expectedQty"
    RETURNING "scannedQty"
  `;
  // Somebody else filled it between reading the box and now. Nothing was
  // written; showing the box as it now stands is the whole answer.
  if (claimed.length === 0) return reload(box.id, "That piece was just recorded from another scanner.");

  await prisma.scanEvent.create({
    data: {
      packageId: box.id,
      userId,
      kind: "ITEM_PLACEHOLDER",
      stockNumber,
      rawScan,
      note: placeholderNote(decision.listing),
    },
  });
  return reload(box.id, `${stockNumber} recorded as this customer's piece.`);
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
  /** Of the sent ones, how many went out without being scanned here. */
  unverified: number;
}

/**
 * Marks every box still open on a day as sent, without scanning them.
 *
 * For a day that has already shipped. Two situations produce one: the days
 * before this app had a packing screen, whose reports still want loading for
 * the sales; and a day the scanner was down, or nobody remembered to use it.
 * The parcels went out either way, and somebody has to be able to say so
 * without scanning six hundred labels after the fact.
 *
 * The boxes are closed as CLOSED_UNVERIFIED, never as complete. Nobody checked
 * them, and the scan log is the thing that answers a customer dispute — writing
 * "complete" into it would be the one lie that makes the whole record worth
 * less. Each box also gets a CLOSE_UNVERIFIED line carrying the reason, so the
 * question "why is this box closed with nothing in its history" is answerable
 * from the history rather than only from the audit log.
 *
 * Boxes that were partly scanned keep every scan they have. Reopening one
 * afterwards works exactly as it always did.
 */
export async function markDaySent(
  userId: string,
  showDate: Date,
  reason: string,
): Promise<{ closed: number } | { error: string }> {
  const why = reason.trim();
  if (why.length < 3) {
    return { error: "Say why this day is being marked sent without scanning." };
  }

  const open = await prisma.package.findMany({
    where: { showDate, status: "OPEN" },
    select: { id: true },
  });
  if (open.length === 0) return { error: "Nothing is still open on that day." };

  const ids = open.map((p) => p.id);
  const at = new Date();

  await prisma.$transaction([
    prisma.package.updateMany({
      where: { id: { in: ids } },
      data: { status: "CLOSED_UNVERIFIED", closedById: userId, closedAt: at },
    }),
    prisma.scanEvent.createMany({
      data: ids.map((packageId) => ({
        packageId,
        userId,
        at,
        kind: "CLOSE_UNVERIFIED" as const,
        note: `Marked sent without scanning: ${why}`,
      })),
    }),
  ]);

  return { closed: ids.length };
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
      where: { package: { showDate }, kind: { in: [...PACKED_ITEM_KINDS] } },
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
  platform: "TIKTOK" | "EBAY";
  buyer: string;
  status: BoxStatus;
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
      platform: true,
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
    platform: r.platform,
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

/**
 * Boxes from the report that nobody has closed yet.
 *
 * Sorted by tracking number, so labels printed together sit together and the
 * list can be checked against a stack. Unrecognised boxes have their own queue.
 */
export async function listOpenBoxes(showDate: Date): Promise<BoxSummary[]> {
  const boxes = await listBoxes({ showDate, status: "OPEN", isUnrecognised: false });
  /*
    Sorted on the first label, not on the cell.

    A two-parcel order's cell begins with a bracket, which sorts before every
    digit — so on 09/26 ninety of the day's 158 boxes would have been lifted out
    of label order and piled at the top, which is the one thing this sort exists
    to prevent.
  */
  return boxes.sort((a, b) => describeTracking(a.tracking).localeCompare(describeTracking(b.tracking)));
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
      where: { userId, kind: { in: [...PACKED_ITEM_KINDS] }, package: { showDate } },
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
  let unverified = 0;
  for (const row of rows) {
    total += row._count._all;
    if (row.status !== "OPEN") sent += row._count._all;
    if (row.status === "CLOSED_INCOMPLETE") incomplete += row._count._all;
    if (row.status === "CLOSED_UNVERIFIED") unverified += row._count._all;
    if (row.isUnrecognised) unrecognised += row._count._all;
  }

  return { dateISO, total, sent, incomplete, unrecognised, unverified };
}

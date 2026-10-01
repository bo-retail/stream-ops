import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { BUSINESS_SHORT, businessOfEbaySeller } from "@/lib/domain/business";
import type { Business } from "@/lib/domain/business";
import { addDays, fromDbDate, toDbDate } from "@/lib/domain/dates";
import { buildBoxes, checkIntegrity, summariseDay } from "@/lib/domain/imports/boxes";
import { carryOver, paidLate } from "@/lib/domain/imports/carry-over";
import type { Box } from "@/lib/domain/imports/boxes";
import { parseCsv } from "@/lib/domain/imports/csv";
import { parseEbayFile, readEbaySeller } from "@/lib/domain/imports/ebay";
import { ebayFallback, placeEbayFile } from "@/lib/domain/imports/ebay-business";
import type { EbayPlacement } from "@/lib/domain/imports/ebay-business";
import { isPlaceholderStock, listingOfNote } from "@/lib/domain/imports/placeholders";
import { parseTikTokFile } from "@/lib/domain/imports/tiktok";
import { detectPlatform } from "@/lib/domain/imports/types";
import type { DroppedRow, ImportFlag, WatchSale } from "@/lib/domain/imports/types";
import type { DateISO } from "@/lib/domain/types";

/**
 * Taking a morning's exports and turning them into the day's boxes.
 *
 * The parsing itself is pure and lives in `src/lib/domain/imports`, where it is
 * tested against the real files. This is only the part that has to touch the
 * database: deciding what to write, and what a second upload of the same day is
 * allowed to disturb.
 */

export interface UploadedFile {
  name: string;
  text: string;
}

export interface ImportOutcome {
  batchId: string | null;
  status: "OK" | "BLOCKED";
  showDate: DateISO | null;
  /** Watches or diamonds. Null only when nothing in the files could be read. */
  business: Business | null;
  flags: ImportFlag[];
  watchCount: number;
  boxCount: number;
  droppedCount: number;
  /** Boxes already closed when this ran. Left exactly as they were. */
  untouchedClosedBoxes: number;
}

const cents = (value: number) => Math.round(value * 100);

/** Money in, whole cents out — never a float in a column that gets totalled. */
function toSalesRow(sale: WatchSale, batchId: string) {
  return {
    batchId,
    business: sale.business,
    platform: sale.platform,
    show: sale.show,
    showDate: toDbDate(sale.showDate),
    shiftTag: sale.shiftTag,
    rawShiftTag: sale.rawShiftTag,
    shiftTagValid: sale.shiftTagValid,
    orderRef: sale.orderRef,
    lineRef: sale.lineRef,
    buyer: sale.buyer,
    stockNumber: sale.stockNumber,
    category: sale.category,
    qty: sale.qty,
    unitPriceCents: cents(sale.unitPrice),
    platformDiscountCents: cents(sale.platformDiscount),
    sellerDiscountCents: cents(sale.sellerDiscount),
    netItemPriceCents: cents(sale.netItemPrice),
    shippingCents: cents(sale.shipping),
    taxAndFeesCents: cents(sale.taxAndFees),
    orderTotalCents: cents(sale.orderTotal),
    soldAt: sale.createdAt,
    paidOn: sale.paidOn ? toDbDate(sale.paidOn) : null,
    shipToName: sale.shipToName,
    state: sale.state,
    paymentMethod: sale.paymentMethod,
    sourcePackageId: sale.packageId,
    tracking: sale.tracking,
    sourceFile: sale.sourceFile,
  };
}

function toDropRow(drop: DroppedRow, batchId: string) {
  return {
    batchId,
    platform: drop.platform,
    orderRef: drop.orderRef,
    buyer: drop.buyer,
    stockNumber: drop.stockNumber,
    amountCents: cents(drop.amount),
    reason: drop.reason,
    sourceFile: drop.sourceFile,
  };
}

/**
 * Reads the files and decides what they say, without writing anything.
 *
 * Separated from the write so the upload screen can show what an import would
 * do — and so a blocked one never gets as far as a transaction.
 */
export function readFiles(
  files: UploadedFile[],
  /**
   * Whose eBay report this is, for any file that does not say so itself.
   *
   * Most files do say: eBay writes the seller account on the last line, and a
   * file naming one the app knows is placed by it rather than by this. This is
   * the answer for the rest, worked out from the schedule. See `placeEbayFile`.
   */
  ebayBusiness: Business = "WATCH",
): {
  sales: WatchSale[];
  dropped: DroppedRow[];
  flags: ImportFlag[];
  boxes: Box[];
  showDate: DateISO | null;
  /** Which kind of show these files are. Null when nothing readable was found. */
  business: Business | null;
  fileInfo: { name: string; platform: string; sha256: string; bytes: number }[];
  /** eBay orders from the day before, paid on this day. See `carryOver`. */
  carried: WatchSale[];
  /** The same, but sharing a label with one of this day's, so kept on this day. */
  keptToday: WatchSale[];
} {
  const flags: ImportFlag[] = [];
  const sales: WatchSale[] = [];
  const dropped: DroppedRow[] = [];
  const fileInfo: { name: string; platform: string; sha256: string; bytes: number }[] = [];

  for (const file of files) {
    const platform = detectPlatform(parseCsv(file.text));
    fileInfo.push({
      name: file.name,
      platform: platform ?? "UNKNOWN",
      sha256: createHash("sha256").update(file.text).digest("hex"),
      bytes: Buffer.byteLength(file.text, "utf8"),
    });

    if (platform === null) {
      flags.push({
        severity: "blocking",
        message: `${file.name} is neither a TikTok nor an eBay order export. Recognised by content, not by name.`,
      });
      continue;
    }

    /*
      Each eBay file placed by its own seller account, and only then by the
      caller's answer.

      Taking one answer for the whole upload is how a diamond report could be
      written under watches: two eBay files, one from an account the app knows
      and one from an account it does not, and the known one placed both. The
      guard below counts the businesses it actually read, so it can only do its
      job if each file is read on its own terms.
    */
    const result =
      platform === "TIKTOK"
        ? parseTikTokFile(file)
        : parseEbayFile(file, ebaySellerBusiness(file.text) ?? ebayBusiness);

    sales.push(...result.sales);
    dropped.push(...result.dropped);
    flags.push(...result.flags);
  }

  /*
    There is no "expected two TikTok files" warning any more.

    It made sense when an upload was the whole day. Files now go up one at a
    time, so one TikTok file is the normal case and warning about it would put
    a complaint on every single upload — which is how people learn to ignore
    warnings. What the day is still waiting for is on the checklist, where it
    belongs, and it is worked out from the schedule rather than from a count.
  */

  /*
    One upload is one kind of show.

    The two sell through separate seller accounts and are scheduled, staffed and
    paid separately, so a single upload holding both would have to be split
    before any of it could be written — and every downstream row, the batch
    included, carries exactly one business. Refusing is honest; guessing a
    business for the batch would put one side's sales under the other's name.
  */
  const businesses = new Set(sales.map((s) => s.business));
  if (businesses.size > 1) {
    const names = [...businesses].map((b) => BUSINESS_SHORT[b]).join(" and ");
    flags.push({
      severity: "blocking",
      message:
        `These files mix ${names} shows. Upload each on its own — they are separate reports, ` +
        `and mixing them would put one show's sales under the other's name.`,
    });
  }

  /*
    A previous day's eBay orders, paid this morning, are taken out before the
    day is decided — so one late payer no longer turns the whole report away.
    They go on to the day they sold in; see `carryOver` and `runImport`.
  */
  const { kept, carried, keptToday } = carryOver(sales);
  if (carried.length + keptToday.length > 0) {
    // The parser's own "two Sale Dates in one file" note is explained by these.
    const late = new Set([...carried, ...keptToday].map((s) => s.sourceFile));
    for (let i = flags.length - 1; i >= 0; i--) {
      if ([...late].some((name) => flags[i].message.startsWith(`${name}: rows carry `))) {
        flags.splice(i, 1);
      }
    }
  }

  const boxes = buildBoxes(kept);
  flags.push(...checkIntegrity(kept, boxes));

  // Every file of one morning describes one show day. More than one means two
  // days' exports were dropped in together, which would put the wrong boxes on
  // the wrong date.
  const dates = new Map<DateISO, number>();
  for (const sale of kept) dates.set(sale.showDate, (dates.get(sale.showDate) ?? 0) + 1);
  const ranked = [...dates.entries()].sort((a, b) => b[1] - a[1]);
  const showDate = ranked[0]?.[0] ?? null;

  if (ranked.length > 1) {
    flags.push({
      severity: "blocking",
      message: `These files cover ${ranked.length} different show days (${ranked
        .map(([d, n]) => `${d}: ${n} ${n === 1 ? "sale" : "sales"}`)
        .join(", ")}). Upload one day at a time.`,
    });
  }
  if (kept.length > 0 && showDate === null) {
    flags.push({ severity: "blocking", message: "No show date could be determined." });
  }

  // Exactly one by the time this returns — anything else is blocking above.
  const business = businesses.size === 1 ? [...businesses][0] : null;

  return { sales: kept, dropped, flags, boxes, showDate, business, fileInfo, carried, keptToday };
}

/**
 * Brings one business's day of boxes in line with what its reports now say.
 *
 * Run after a line of the day's checklist has been written — by an upload, or
 * by a late order being added to the previous day's eBay report. Reads every
 * current line of the day, so a box spanning two shows keeps both.
 */
async function reconcileDayBoxes(
  tx: Prisma.TransactionClient,
  {
    business,
    showDate,
    batchId,
    supersededIds,
    splitOrigins,
  }: {
    business: Business;
    showDate: DateISO;
    /** The upload now responsible for the boxes it touches. */
    batchId: string;
    /** The uploads just replaced, whose untouched boxes may be swept away. */
    supersededIds: string[];
    splitOrigins: string[];
  },
): Promise<{ untouchedClosedBoxes: number }> {

  /*
    What this business's day now holds, across every line of its checklist.

    A box can legitimately span two shows — one buyer buying in the morning
    and again at night gets one label — so what belongs in it cannot be
    worked out from the file just uploaded. Re-reading the day's other
    reports is what stops a corrected TikTok night file emptying a box of
    the watches its day-show file put there.

    Read back from what was just written, so the new line is included and
    the superseded one is not.
  */
  const current = await tx.importBatch.findMany({
    where: {
      business: business,
      showDate: toDbDate(showDate),
      status: "OK",
      id: { notIn: supersededIds.length > 0 ? supersededIds : ["-"] },
    },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, platform: true, slot: true },
  });
  const liveByLine = new Map<string, string>();
  for (const b of current) {
    const key = `${b.platform ?? ""}|${b.slot ?? ""}`;
    if (!liveByLine.has(key)) liveByLine.set(key, b.id);
  }
  const liveBatchIds = [...liveByLine.values()];

  const dayRows = await tx.salesRecord.findMany({
    where: { batchId: { in: liveBatchIds } },
    select: {
      tracking: true,
      platform: true,
      buyer: true,
      shipToName: true,
      state: true,
      showDate: true,
      show: true,
      stockNumber: true,
      qty: true,
      orderRef: true,
    },
  });
  const dayBoxes = buildBoxes(
    dayRows.map((r) => ({
      ...r,
      showDate: fromDbDate(r.showDate),
      show: r.show as WatchSale["show"],
    })),
  );
  const dayTrackings = dayBoxes.map((b) => b.tracking);

  const existing = await tx.package.findMany({
    where: { trackingNumber: { in: dayTrackings } },
    select: {
      id: true,
      trackingNumber: true,
      status: true,
      items: { select: { id: true, stockNumber: true, scannedQty: true } },
      // The real pieces a packer recorded against placeholder lines, so a
      // report that now names them can be matched to what is in the box.
      scans: {
        where: { kind: "ITEM_PLACEHOLDER" },
        select: { stockNumber: true, note: true },
      },
    },
  });
  const byTracking = new Map(existing.map((p) => [p.trackingNumber, p]));
  const closed = existing.filter((p) => p.status !== "OPEN");
  const closedTracking = new Set(closed.map((p) => p.trackingNumber));

  const fresh = dayBoxes.filter((b) => !byTracking.has(b.tracking));
  if (fresh.length > 0) {
    await tx.package.createMany({
      data: fresh.map((b) => ({
        trackingNumber: b.tracking,
        business: business,
        platform: b.platform,
        showDate: toDbDate(b.showDate),
        buyer: b.buyer,
        shipToName: b.shipToName,
        shipToState: b.state,
        batchId: batchId,
      })),
      skipDuplicates: true,
    });

    // createMany does not return ids, so the new rows are read back once
    // rather than inserted one at a time.
    const created = await tx.package.findMany({
      where: { trackingNumber: { in: fresh.map((b) => b.tracking) } },
      select: { id: true, trackingNumber: true },
    });
    const idOf = new Map(created.map((p) => [p.trackingNumber, p.id]));
    await tx.packageItem.createMany({
      data: fresh.flatMap((b) =>
        b.items.map((i) => ({
          packageId: idOf.get(b.tracking)!,
          stockNumber: i.stockNumber,
          expectedQty: i.expected,
        })),
      ),
    });
  }

  // An open box that already existed: bring the expected counts in line,
  // but never discard what somebody has already scanned into it.
  for (const box of dayBoxes) {
    const row = byTracking.get(box.tracking);
    if (!row || row.status !== "OPEN") continue;

    await tx.package.update({
      where: { id: row.id },
      data: {
        platform: box.platform,
        showDate: toDbDate(box.showDate),
        buyer: box.buyer,
        shipToName: box.shipToName,
        shipToState: box.state,
        batchId: batchId,
        isUnrecognised: false,
      },
    });

    const wanted = new Map(box.items.map((i) => [i.stockNumber, i.expected]));

    /*
      A placeholder the report has now replaced with the real SKU.

      Dani switches "LGD #3" to the piece's real stock number after the
      show, so a report downloaded again later names the real piece where
      the placeholder was. If the packer already scanned that piece's tag
      against the placeholder, it is in the box: the scan counts for the
      real line, and the placeholder line goes. Without this, the placeholder
      would read "1 scanned, 0 expected" and the real line "0 of 1", and a
      correctly packed box could only close incomplete.

      Only a piece the report now names in this very box is carried across.
      A different real SKU from the one she scanned is a genuine mismatch,
      and is left exactly as it is for the director to see.
    */
    const carried = new Map<string, number>();
    const placeholderLeft = new Map<string, number>();
    for (const item of row.items) {
      if (!isPlaceholderStock(item.stockNumber) || wanted.has(item.stockNumber)) continue;
      let left = item.scannedQty;
      for (const scan of row.scans) {
        if (left === 0) break;
        if (listingOfNote(scan.note) !== item.stockNumber || !scan.stockNumber) continue;
        if (!wanted.has(scan.stockNumber)) continue;
        carried.set(scan.stockNumber, (carried.get(scan.stockNumber) ?? 0) + 1);
        left--;
      }
      placeholderLeft.set(item.id, left);
    }

    for (const item of row.items) {
      const expected = wanted.get(item.stockNumber);
      if (expected === undefined) {
        // Gone from the file. Drop it if nothing of it is in the box; if it
        // was scanned, that happened and the row stays, expecting nothing.
        const scanned = placeholderLeft.get(item.id) ?? item.scannedQty;
        if (scanned === 0) {
          await tx.packageItem.delete({ where: { id: item.id } });
        } else {
          await tx.packageItem.update({
            where: { id: item.id },
            data: { expectedQty: 0, scannedQty: scanned },
          });
        }
        wanted.delete(item.stockNumber);
        continue;
      }
      await tx.packageItem.update({
        where: { id: item.id },
        data: {
          expectedQty: expected,
          ...(carried.has(item.stockNumber)
            ? { scannedQty: item.scannedQty + carried.get(item.stockNumber)! }
            : {}),
        },
      });
      wanted.delete(item.stockNumber);
    }

    const known = new Set(row.items.map((i) => i.stockNumber));
    const added = [...wanted.entries()].filter(([stock]) => !known.has(stock));
    if (added.length > 0) {
      await tx.packageItem.createMany({
        data: added.map(([stockNumber, expectedQty]) => ({
          packageId: row.id,
          stockNumber,
          expectedQty,
          scannedQty: carried.get(stockNumber) ?? 0,
        })),
      });
    }
  }

  /*
    Boxes this line put there before and that its new file no longer has.
    Only ones nobody has touched; the foreign key refuses the rest anyway.

    Matched on the batches this upload supersedes rather than on the whole
    day, which is the difference between replacing a file and replacing a
    day. A corrected TikTok night file sweeps away the boxes the old TikTok
    night file made and nothing else — not the day show's, not eBay's, not
    the diamond report's from the same morning.

    A day that has never had this line loaded supersedes nothing, so this is
    a no-op on a first upload.
  */
  if (supersededIds.length > 0) {
    await tx.package.deleteMany({
      where: {
        batchId: { in: [...supersededIds, ...splitOrigins] },
        status: "OPEN",
        /*
          Measured against the whole day, not against the file just
          uploaded.

          A box can hold watches from two shows, and it carries the id of
          whichever upload last touched it. If a buyer's night order is
          cancelled and the night file re-uploaded, that box leaves the
          night file — but their morning watch is still in it, and against
          this upload alone the box would be deleted out from under the
          packer holding it.
        */
        trackingNumber: { notIn: dayTrackings.length > 0 ? dayTrackings : ["-"] },
        scans: { none: {} },
      },
    });
  }


  return { untouchedClosedBoxes: closedTracking.size };
}

/** A row as it would be inserted again: everything but the id it already has. */
function withoutId<T extends { id: string }>(row: T): Omit<T, "id"> {
  const copy: Partial<T> = { ...row };
  delete copy.id;
  return copy as Omit<T, "id">;
}

const orderList = (sales: readonly { orderRef: string }[]) =>
  [...new Set(sales.map((s) => s.orderRef))].join(", ");

type Db = Prisma.TransactionClient | typeof prisma;

/** A business's current eBay report for a day, if one is loaded. */
function currentEbayReport(db: Db, business: Business, day: DateISO) {
  return db.importBatch.findFirst({
    where: { business, showDate: toDbDate(day), status: "OK", platform: "EBAY", slot: null },
    orderBy: { uploadedAt: "desc" },
    select: {
      id: true,
      files: true,
      flags: true,
      watchCount: true,
      boxCount: true,
      droppedCount: true,
    },
  });
}

/** The file names an upload recorded, so rows from anywhere else can be told apart. */
function fileNames(files: Prisma.JsonValue): Set<string> {
  if (!Array.isArray(files)) return new Set();
  return new Set(
    files
      .map((f) => (f && typeof f === "object" && !Array.isArray(f) ? f.name : null))
      .filter((n): n is string => typeof n === "string"),
  );
}

/**
 * What to tell the uploader about a previous day's late eBay orders, worked
 * out before anything is written.
 *
 * Added to that day's eBay report when it is loaded and does not have them yet:
 * that is where they sold, so that show's pair are paid for them, and their box
 * is made on that day. Already there — a report downloaded after the buyer paid
 * — and they are left alone, so nothing is boxed or paid twice. Not loaded at
 * all, and they are left out and named: a report of one order would read on
 * the checklist as the whole of that day's eBay.
 *
 * The write re-reads all of this inside its transaction (`addToPreviousReport`),
 * so a report that changes in between is never overwritten from a stale copy.
 */
async function planCarryOver(
  day: DateISO,
  carried: WatchSale[],
  keptToday: WatchSale[],
): Promise<{ add: WatchSale[]; flags: ImportFlag[] }> {
  const flags: ImportFlag[] = [];

  if (keptToday.length > 0) {
    flags.push({
      severity: "warning",
      message:
        `eBay order(s) ${orderList(keptToday)} sold in the ${keptToday[0].showDate} show but were paid on ${day}, ` +
        `and share a shipping label with one of ${day}'s orders. They were kept on ${day} so that box is ` +
        `complete — which means their commission counts towards ${day}'s ${keptToday[0].show} show, not ` +
        `${keptToday[0].showDate}'s. If nobody was on that show, payroll lists it as sales nobody is paid for.`,
    });
  }
  if (carried.length === 0) return { add: [], flags };

  const before = carried[0].showDate;
  const business = carried[0].business;
  const found = await currentEbayReport(prisma, business, before);

  if (!found) {
    flags.push({
      severity: "warning",
      message:
        `eBay order(s) ${orderList(carried)} sold in the ${before} show but were paid on ${day}, so they are in ` +
        `this report. ${before} has no ${BUSINESS_SHORT[business]} eBay report loaded yet, so they were left out ` +
        `rather than made into one — upload ${before}'s eBay report and check they are in it.`,
    });
    return { add: [], flags };
  }

  const there = new Set(
    (
      await prisma.salesRecord.findMany({
        where: { batchId: found.id, orderRef: { in: carried.map((s) => s.orderRef) } },
        select: { orderRef: true },
      })
    ).map((r) => r.orderRef),
  );
  const already = carried.filter((s) => there.has(s.orderRef));
  const add = carried.filter((s) => !there.has(s.orderRef));

  if (already.length > 0) {
    flags.push({
      severity: "info",
      message:
        `eBay order(s) ${orderList(already)} sold in the ${before} show and are already in ${before}'s ` +
        `eBay report, so they were not added again.`,
    });
  }

  if (add.length > 0) {
    const sent = await prisma.package.findMany({
      where: {
        trackingNumber: { in: add.map((s) => s.tracking).filter((t) => t !== "") },
        status: { not: "OPEN" },
      },
      select: { trackingNumber: true },
    });
    flags.push({
      severity: "info",
      message:
        `eBay order(s) ${orderList(add)} sold in the ${before} show but were paid on ${day}, so they are in ` +
        `this report. They were added to ${before}'s eBay report instead: their box is on ${before}, and the ` +
        `commission goes to that show.`,
    });
    if (sent.length > 0) {
      flags.push({
        severity: "warning",
        message:
          `The box for ${sent.map((p) => p.trackingNumber).join(", ")} on ${before} was already closed, so ` +
          `the late order was added to the report but not to the box. Check that parcel by hand.`,
      });
    }
  }

  return { add, flags };
}

/**
 * One eBay report line at a time.
 *
 * Two uploads that touch the same day's eBay report — this morning's, carrying
 * a late order onto yesterday, and a corrected copy of yesterday's — each copy
 * the report as it stood and write a new version. Run side by side, whichever
 * writes second replaces the other's, and its orders drop out of the day. A
 * transaction-scoped lock on that one report makes the second wait for the
 * first and then read what it wrote.
 *
 * Always taken latest day first (a morning's own report, then the day before),
 * so two uploads can never each hold what the other is waiting for.
 */
async function lockEbayReport(tx: Prisma.TransactionClient, business: Business, day: DateISO) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ebay-report|${business}|${day}`})::bigint)`;
}

/**
 * Late orders added to an earlier day's eBay report.
 *
 * Written as a new version of that report — everything it held, plus these —
 * exactly as if it had been uploaded again with them in. Every reader takes
 * the latest version of each line, so payroll, insights and the shipping log
 * see one report, and the version before stays on record.
 *
 * Nothing is ever taken off this way. A late order later cancelled stays on
 * that day: eBay's report has no "cancelled" row to say so — an order simply
 * stops appearing, which looks exactly like a report downloaded before the
 * buyer paid. Taking it off is a person's decision (remove that day's eBay
 * upload and load it again).
 *
 * Read again here, inside the transaction and under the report's lock, rather
 * than trusting what `planCarryOver` saw.
 */
async function updateEarlierReport(
  tx: Prisma.TransactionClient,
  target: { business: Business; day: DateISO },
  add: WatchSale[],
  uploadedById: string,
  notes: ImportFlag[],
): Promise<{ batchId: string; pieces: number; newBoxes: number } | null> {
  if (add.length === 0) return null;
  const { business, day } = target;

  await lockEbayReport(tx, business, day);
  const previous = await currentEbayReport(tx, business, day);
  if (!previous) {
    {
      notes.push({
        severity: "warning",
        message:
          `${day}'s eBay report was removed while this was uploading, so late order(s) ${orderList(add)} ` +
          `were not added to it. Upload ${day}'s eBay report again and check they are in it.`,
      });
    }
    return null;
  }

  const rows = await tx.salesRecord.findMany({ where: { batchId: previous.id } });
  const drops = await tx.importDrop.findMany({ where: { batchId: previous.id } });
  const present = new Set(rows.map((r) => r.orderRef));
  const adding = add.filter((s) => !present.has(s.orderRef));
  if (adding.length === 0) return null;

  const known = new Set(rows.map((r) => r.tracking).filter((t) => t !== ""));
  const newBoxes = new Set(adding.map((s) => s.tracking).filter((t) => t !== "" && !known.has(t)));
  const pieces = adding.reduce((n, s) => n + (s.qty || 1), 0);

  const batch = await tx.importBatch.create({
    data: {
      business,
      platform: "EBAY",
      slot: null,
      showDate: toDbDate(day),
      status: "OK",
      uploadedById,
      // The report's own files, unchanged. The late rows keep the name of the
      // file they came from, which is how a later correction of this report
      // knows them from its own rows and keeps them (see `lateAdditions`).
      files: previous.files ?? [],
      flags: [
        ...(Array.isArray(previous.flags) ? previous.flags : []),
        {
          severity: "info",
          message: `Late order(s) ${orderList(adding)} added from a later day's report: sold in this show, paid after it.`,
        },
      ] as Prisma.InputJsonValue[],
      watchCount: previous.watchCount + pieces,
      boxCount: previous.boxCount + newBoxes.size,
      droppedCount: previous.droppedCount,
    },
    select: { id: true },
  });

  if (rows.length > 0) {
    await tx.salesRecord.createMany({
      data: rows.map((row) => ({ ...withoutId(row), batchId: batch.id })),
    });
  }
  if (drops.length > 0) {
    await tx.importDrop.createMany({
      data: drops.map((drop) => ({ ...withoutId(drop), batchId: batch.id })),
    });
  }
  await tx.salesRecord.createMany({ data: adding.map((s) => toSalesRow(s, batch.id)) });

  const origin = previous.id.split("-")[0];
  await reconcileDayBoxes(tx, {
    business,
    showDate: day,
    batchId: batch.id,
    supersededIds: [previous.id],
    splitOrigins: origin !== previous.id ? [origin] : [],
  });

  return { batchId: batch.id, pieces, newBoxes: newBoxes.size };
}

/**
 * Late orders an eBay report was given by a later day's upload, still wanted.
 *
 * When that report is corrected — uploaded again from a fresh download — the
 * new file only has them if it was downloaded after the buyer paid. One that
 * was not would quietly drop them: out of the day's sales, out of the pay, and
 * their box swept off the floor. So they are carried into the new version,
 * unless the new file has the order itself, sold or cancelled.
 *
 * Known by their file: a late row keeps the name of the morning report it came
 * in, which is not one of the files the day's own report was made from. Paid
 * after the show, too — a second check that this is what it looks like.
 */
async function lateAdditions(
  tx: Prisma.TransactionClient,
  latest: { id: string; files: Prisma.JsonValue } | null,
  inNewFile: Set<string>,
) {
  if (!latest) return [];
  const own = fileNames(latest.files);
  if (own.size === 0) return [];
  const rows = await tx.salesRecord.findMany({ where: { batchId: latest.id } });
  return rows.filter(
    (r) =>
      !own.has(r.sourceFile) &&
      r.paidOn !== null &&
      r.paidOn > r.showDate &&
      !inNewFile.has(r.orderRef),
  );
}

/**
 * A morning's files, written as one upload per business.
 *
 * Watches and diamonds are separate reports — separate seller accounts,
 * separate checklists, separate pay — and one upload is one business. But the
 * person uploading has five files from one morning, and asking them to sort
 * which is which, when every file already says whose it is, turned the whole
 * 09/30 morning away. So a drop holding both is split here, by what each file
 * says, and each half goes up on its own exactly as if it had been dropped
 * alone.
 *
 * Split only when every file can place itself: a TikTok file by its shop, an
 * eBay file by its seller account. A file that cannot is left to the ordinary
 * path, which works it out from the schedule or refuses and says why.
 */
export async function runImports(
  files: UploadedFile[],
  uploadedById: string,
): Promise<ImportOutcome[]> {
  const groups = splitByBusiness(files);
  if (groups.length === 1) return [await runImport(files, uploadedById)];

  /*
    Each half is its own upload and its own transaction, so one can fail after
    the other has gone in. The failure is reported as that half's refusal
    rather than thrown, which would hide that the first half was written.
  */
  const outcomes: ImportOutcome[] = [];
  for (const group of groups) {
    try {
      outcomes.push(await runImport(group, uploadedById));
    } catch (error) {
      outcomes.push({
        batchId: null,
        status: "BLOCKED",
        showDate: null,
        business: ownerOf(group[0]),
        flags: [
          {
            severity: "blocking",
            message: `The upload could not be completed: ${error instanceof Error ? error.message : "unknown error"}`,
          },
        ],
        watchCount: 0,
        boxCount: 0,
        droppedCount: 0,
        untouchedClosedBoxes: 0,
      });
    }
  }
  return outcomes;
}

/** Files grouped by the business each one names, watches first. One group when they agree. */
export function splitByBusiness(files: UploadedFile[]): UploadedFile[][] {
  const owner = files.map(ownerOf);
  if (owner.some((b) => b === null)) return [files];
  const kinds = [...new Set(owner)] as Business[];
  if (kinds.length < 2) return [files];
  return (["WATCH", "DIAMOND"] as const)
    .filter((b) => kinds.includes(b))
    .map((b) => files.filter((_, i) => owner[i] === b));
}

/** Whose file this is, by what it says itself: a TikTok shop, or an eBay seller account. */
function ownerOf(file: UploadedFile): Business | null {
  const platform = detectPlatform(parseCsv(file.text));
  if (platform === "EBAY") return ebaySellerBusiness(file.text);
  if (platform === "TIKTOK") return readFiles([file]).business;
  return null;
}

/** The business an eBay export names on its last line, if we know the account. */
function ebaySellerBusiness(text: string): Business | null {
  const seller = readEbaySeller(text);
  return seller ? businessOfEbaySeller(seller) : null;
}

/** Which line of a day's checklist a sale fills. */
function lineKey(sale: WatchSale): string {
  return sale.platform === "EBAY"
    ? "EBAY|"
    : `TIKTOK|${sale.show.endsWith("AM") ? "DAY" : "NIGHT"}`;
}

/**
 * The single line a set of sales belongs to, or null when it is not one line.
 *
 * Null covers both nothing readable and a mix of several, because neither can
 * be recorded against one row of the checklist without being wrong about it.
 */
function linesIn(sales: readonly WatchSale[]): {
  platform: "TIKTOK" | "EBAY";
  slot: "DAY" | "NIGHT" | null;
} | null {
  const keys = new Set(sales.map(lineKey));
  if (keys.size !== 1) return null;
  const [platform, slot] = [...keys][0].split("|");
  return {
    platform: platform as "TIKTOK" | "EBAY",
    slot: (slot || null) as "DAY" | "NIGHT" | null,
  };
}

/**
 * Whose eBay report a day's export is, read off the published schedule.
 *
 * The one piece of this that needs the database, kept apart from the rule
 * itself so the rule can be tested on its own — see `placeEbayFile`.
 */
async function resolveEbayBusiness(showDate: DateISO): Promise<EbayPlacement> {
  const shows = await prisma.show.findMany({
    where: { date: toDbDate(showDate), release: { scheduleStatus: "PUBLISHED" } },
    select: { business: true, platform: true, status: true },
  });
  return placeEbayFile(
    shows.map((s) => ({
      business: s.business,
      platform: s.platform,
      cancelled: s.status === "CANCELLED",
    })),
  );
}

/**
 * Reads the files and writes the day.
 *
 * A second upload of the same day is expected — a corrected export, a file that
 * was missing first time. What it may disturb is deliberately narrow:
 *
 *   - a **closed** box is never touched, in any way
 *   - an **open** box has its expected contents brought in line, but a count
 *     somebody has already scanned is kept
 *   - a box that has vanished from the file is removed only if it is open and
 *     nobody has scanned it; the database refuses the rest regardless
 *
 * The batch history is kept rather than overwritten, so "what did the first
 * upload say" stays answerable.
 */
export async function runImport(
  files: UploadedFile[],
  uploadedById: string,
): Promise<ImportOutcome> {
  /*
    Read once to learn the day, then resolve whose eBay report it is and read
    again.

    Two passes because the answer depends on the date and the date comes out of
    the files. Parsing 200KB twice costs nothing next to getting it wrong, and
    the alternative — asking the uploader which show their eBay file is for,
    every single morning — is a question the schedule can already answer.

    That still makes a diamond eBay show work the day it is published, with one
    exception: a day when both ran eBay, where the schedule cannot choose. Then
    the file's own seller account decides — and if that account has never been
    seen before, it has to be registered in `business.ts`, which is a line and a
    deploy. The refusal below says so, and names the account.
  */
  const firstPass = readFiles(files);
  const scheduled = firstPass.showDate
    ? await resolveEbayBusiness(firstPass.showDate)
    : { kind: "noShow" as const, business: "WATCH" as const };

  /*
    The file's own seller account, which beats the schedule.

    eBay does name its seller — on the last line, below the record count. So a
    day when both kinds of show ran eBay is only unanswerable if the account is
    one nobody has registered; otherwise the file says whose it is, the same way
    a TikTok export names its shop.
  */
  const ebayFiles = files.filter(
    (f) => firstPass.fileInfo.find((i) => i.name === f.name)?.platform === "EBAY",
  );
  const sellerIds = [
    ...new Set(ebayFiles.map((f) => readEbaySeller(f.text)).filter((s): s is string => s !== null)),
  ];
  const fallback = ebayFallback(
    ebayFiles.map((f) => ebaySellerBusiness(f.text)),
    scheduled,
  );
  const ebayBusiness: EbayPlacement =
    fallback.kind === "fallback" ? { kind: "placed", business: fallback.business } : scheduled;

  const read = readFiles(files, ebayBusiness.kind === "ambiguous" ? "WATCH" : ebayBusiness.business);
  const { dropped, flags, showDate, business, fileInfo, keptToday } = read;
  let { sales, boxes, carried } = read;

  /*
    The file and the schedule disagree about whose eBay show this was.

    The file wins — it is direct evidence and the schedule is a calendar — but
    one of the two is then wrong, and the schedule is what the pay is worked out
    from. Said out loud rather than quietly preferred.
  */
  if (
    scheduled.kind === "placed" &&
    ebayBusiness.kind === "placed" &&
    scheduled.business !== ebayBusiness.business
  ) {
    flags.push({
      severity: "warning",
      message:
        `The schedule says ${BUSINESS_SHORT[scheduled.business]} ran eBay on ${firstPass.showDate}, ` +
        `but this report was exported by ${BUSINESS_SHORT[ebayBusiness.business]}'s account ` +
        `("${sellerIds[0]}"). The file was believed — check the schedule, because the pay is worked ` +
        `out from it.`,
    });
  }

  /*
    Both sold eBay that day, and a file has no account we recognise.

    Only the files without one are stuck: any file naming a known account has
    already placed itself above. Refused rather than filed under whichever
    business was read first, which would pay the wrong pair.
  */
  if (fallback.kind === "unplaceable" && fileInfo.some((f) => f.platform === "EBAY")) {
    flags.push({
      severity: "blocking",
      message:
        `${firstPass.showDate} ran an eBay show for both ${fallback.candidates
          .map((b) => BUSINESS_SHORT[b])
          .join(" and ")}, and nothing here says which of them this report is. ` +
        (sellerIds.length > 0
          ? `It was exported by the eBay account "${sellerIds[0]}", which the app has not been told about. ` +
            `Send that name to your admin — registering it is one line, and then this answers itself every time.`
          : `The file does not name its seller account, which every eBay export normally does on its last ` +
            `line. Upload the two days separately, or tell your admin which this one is.`),
    });
  }

  /*
    There is deliberately no "upload them all together" guard any more.

    It existed because an upload used to BE the day: a second one replaced
    everything the first had written, so sending up a single missing file would
    have taken every other sale and every unpacked box with it. The guard stopped
    that, and in doing so refused Flora's diamond file on 09/16 — the watch day
    was already in, the diamond file did not contain it, and that read as taking
    a marketplace away.

    An upload is now one line of the day's checklist and supersedes only its own
    line, so there is nothing left to protect against. Files go up one at a time,
    in any order, whenever each is ready.
  */
  const blocked = flags.some((f) => f.severity === "blocking");

  /*
    An eBay report holding nothing but the day before's late payers.

    A morning after a day with no eBay show: everything in the file sold the
    day before and was paid after midnight, so the file reads as that day's —
    and written as that day's, it would replace that day's real eBay report
    and sweep its boxes off the floor. When that day already has a report,
    these are late orders for it, exactly as if they had come in with today's.
    When it has none, this is the best report of that day there is, and goes in
    as one.
  */
  /*
    Unless the file is that day's own report, corrected. A small report — a
    diamond eBay with a sale or two — can have every buyer pay after midnight
    and still be the day's report, and a corrected copy of it must replace it,
    not be folded in. Told apart by what the day already holds: if any order in
    the file is there as one of the day's own, this is the day's report.
  */
  let lateDay: DateISO | null = null;
  const onlyLatePayers =
    !blocked &&
    showDate !== null &&
    carried.length === 0 &&
    sales.length > 0 &&
    sales.every((s) => s.platform === "EBAY" && paidLate(s));
  const existing = onlyLatePayers ? await currentEbayReport(prisma, sales[0].business, showDate!) : null;
  const ownOrders = existing
    ? await prisma.salesRecord.count({
        where: {
          batchId: existing.id,
          orderRef: { in: sales.map((s) => s.orderRef) },
          sourceFile: { in: [...fileNames(existing.files)] },
        },
      })
    : 0;
  if (existing && ownOrders === 0) {
    carried = sales;
    sales = [];
    boxes = [];
    lateDay = [...carried].map((s) => s.paidOn as DateISO).sort().at(-1) ?? null;
  }

  // Where the previous day's late orders go. Decided before anything is
  // written, so what it says is on this upload's own record too.
  const carry =
    !blocked && showDate !== null
      ? await planCarryOver(lateDay ?? showDate, carried, keptToday)
      : { add: [], flags: [] };
  flags.push(...carry.flags);

  if (blocked || showDate === null) {
    // Recorded rather than discarded: a refused upload is the most useful thing
    // to be able to look at afterwards.
    /*
      A refusal is recorded against the line it was aimed at, when that much
      could be read.

      So a turned-away TikTok night file shows as refused on the TikTok night
      row of the checklist and nowhere else — the other three lines are somebody
      else's business and carry on saying what they actually are. A file too
      broken to place at all, or one mixing two lines, has no line to record and
      shows on the day instead.
    */
    const refusedLine = linesIn(sales);

    const batch = await prisma.importBatch.create({
      data: {
        business: business ?? "WATCH",
        platform: refusedLine?.platform ?? null,
        slot: refusedLine?.slot ?? null,
        showDate: toDbDate(showDate ?? "1970-01-01"),
        status: "BLOCKED",
        uploadedById,
        files: fileInfo,
        flags: flags as unknown as object[],
        watchCount: 0,
        boxCount: 0,
        droppedCount: 0,
      },
      select: { id: true },
    });
    return {
      batchId: batch.id,
      status: "BLOCKED",
      showDate,
      business,
      flags,
      watchCount: 0,
      boxCount: 0,
      droppedCount: 0,
      untouchedClosedBoxes: 0,
    };
  }

  // The whole upload's figures, for what this call reports back. Each line's
  // own counts are worked out per line below.
  const summary = summariseDay(sales, boxes);

  /*
    Which line of the day's checklist this upload fills.

    A day is a list of separate exports — one per TikTok show, one per business
    selling on eBay — each produced at a different moment. TikTok's slot comes
    from the show the file was decided to be; eBay has none, because its single
    export covers the whole day however many eBay shows ran.

    One upload is one line. Anything that would fill two at once was refused
    above, so there is exactly one here.
  */
  const lines = new Set(sales.map(lineKey));

  /*
    An upload may still carry several files at once — three most mornings — and
    each one is its own line. They are written as separate batches so that
    correcting any one of them later touches only that one.

    A file's drops go with its own line. A file whose every row was cancelled
    has no sales and so no line of its own; its drops join the first, which is
    the exceptions list rather than anything anybody is paid from.
  */
  const lineOf = lineKey;
  const fileLine = new Map<string, string>();
  for (const s of sales) fileLine.set(s.sourceFile, lineOf(s));

  const keys = [...lines];
  // What the write found out that nothing could know beforehand.
  const notes: ImportFlag[] = [];
  const written = await prisma.$transaction(
    async (tx) => {
      const supersededIds: string[] = [];
      const splitOrigins: string[] = [];
      let firstBatchId = "";

      for (const key of keys) {
        const [platform, slot] = key.split("|");
        const line = {
          platform: (platform || null) as "TIKTOK" | "EBAY" | null,
          slot: (slot || null) as "DAY" | "NIGHT" | null,
        };

        const mine = sales.filter((s) => lineOf(s) === key);
        const myDrops = dropped.filter(
          (d) => (fileLine.get(d.sourceFile) ?? keys[0]) === key,
        );
        const myFiles = fileInfo.filter(
          (f) => (fileLine.get(f.name) ?? keys[0]) === key,
        );
        const myBoxes = buildBoxes(mine);

        /*
          What this line held before.

          Only these boxes may be swept away at the end. A day holds several
          reports side by side — two TikTok shows, an eBay export, and the same
          again for diamonds — and a corrected TikTok night file must not touch
          a single box that came from any of the others.
        */
        if (line.platform === "EBAY") await lockEbayReport(tx, business ?? "WATCH", showDate);
        const previous = await tx.importBatch.findMany({
          where: {
            business: business ?? "WATCH",
            showDate: toDbDate(showDate),
            status: "OK",
            platform: line.platform,
            slot: line.slot,
          },
          orderBy: { uploadedAt: "desc" },
          select: { id: true, files: true },
        });

        // A corrected eBay report keeps the late orders a later morning gave
        // the one it replaces. See `lateAdditions`.
        const keptLate =
          line.platform === "EBAY"
            ? await lateAdditions(
                tx,
                previous[0] ?? null,
                new Set([...mine.map((s) => s.orderRef), ...myDrops.map((d) => d.orderRef)]),
              )
            : [];
        if (keptLate.length > 0) {
          flags.push({
            severity: "info",
            message:
              `Kept eBay order(s) ${orderList(keptLate)} on this report: they were added from a later ` +
              `day's report (sold in this show, paid after it) and this file does not have them.`,
          });
        }
        const lateTracking = new Set(myBoxes.map((b) => b.tracking));
        supersededIds.push(...previous.map((b) => b.id));
        /*
          A day loaded before the checklist was split into lines on the way in,
          and its later lines are copies whose ids extend the original's — which
          is the one its boxes still point at. Replacing one of those lines must
          be able to clear that day's stale boxes too, so the original counts as
          replaced along with it — for the box clean-up only. The original is
          still another line's current upload, so it must never be counted as
          replaced when working out what the day holds. Only boxes nothing on
          the day still wants are ever cleared (see the end of this), so this
          widens what is considered, not what is removed.
        */
        for (const b of previous) {
          const origin = b.id.split("-")[0];
          if (origin !== b.id) splitOrigins.push(origin);
        }

        const batch = await tx.importBatch.create({
          data: {
            business: business ?? "WATCH",
            platform: line.platform,
            slot: line.slot,
            showDate: toDbDate(showDate),
            status: "OK",
            uploadedById,
            files: myFiles,
            flags: flags as unknown as object[],
            // Pieces, not rows — the same count the rest of the day uses.
            watchCount:
              mine.reduce((n, s) => n + (s.qty || 1), 0) +
              keptLate.reduce((n, r) => n + (r.qty || 1), 0),
            boxCount:
              myBoxes.length +
              new Set(keptLate.map((r) => r.tracking).filter((t) => t !== "" && !lateTracking.has(t))).size,
            droppedCount: myDrops.length,
          },
          select: { id: true },
        });
        if (!firstBatchId) firstBatchId = batch.id;

        if (mine.length > 0) {
          await tx.salesRecord.createMany({ data: mine.map((s) => toSalesRow(s, batch.id)) });
        }
        if (keptLate.length > 0) {
          await tx.salesRecord.createMany({
            data: keptLate.map((row) => ({ ...withoutId(row), batchId: batch.id })),
          });
        }
        if (myDrops.length > 0) {
          await tx.importDrop.createMany({ data: myDrops.map((d) => toDropRow(d, batch.id)) });
        }
      }

      // Nothing of this day's own — an eBay report of nothing but the day
      // before's late payers — and there is no day to bring in line.
      const { untouchedClosedBoxes } =
        keys.length > 0
          ? await reconcileDayBoxes(tx, {
              business: business ?? "WATCH",
              showDate,
              batchId: firstBatchId,
              supersededIds,
              splitOrigins,
            })
          : { untouchedClosedBoxes: 0 };

      // The day before's eBay report gets its late orders.
      const late = await updateEarlierReport(
        tx,
        {
          business: business ?? "WATCH",
          day: lateDay ? carried[0].showDate : addDays(showDate, -1),
        },
        carry.add,
        uploadedById,
        notes,
      );

      return {
        batchId: firstBatchId || late?.batchId || null,
        untouchedClosedBoxes,
        late,
      };
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  return {
    batchId: written.batchId,
    status: "OK",
    // An all-late report went to the day before, and says so.
    showDate: lateDay ? carried[0].showDate : showDate,
    business,
    flags: [...flags, ...notes],
    watchCount: sales.length > 0 ? summary.watches : (written.late?.pieces ?? 0),
    boxCount: sales.length > 0 ? summary.boxes : (written.late?.newBoxes ?? 0),
    droppedCount: dropped.length,
    untouchedClosedBoxes: written.untouchedClosedBoxes,
  };
}

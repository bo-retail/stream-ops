import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { BUSINESS_SHORT } from "@/lib/domain/business";
import type { Business } from "@/lib/domain/business";
import { toDbDate } from "@/lib/domain/dates";
import { buildBoxes, checkIntegrity, summariseDay } from "@/lib/domain/imports/boxes";
import type { Box } from "@/lib/domain/imports/boxes";
import { parseCsv } from "@/lib/domain/imports/csv";
import { parseEbayFile } from "@/lib/domain/imports/ebay";
import { platformsDropped, platformsOf } from "@/lib/domain/imports/expected";
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
export function readFiles(files: UploadedFile[]): {
  sales: WatchSale[];
  dropped: DroppedRow[];
  flags: ImportFlag[];
  boxes: Box[];
  showDate: DateISO | null;
  /** Which kind of show these files are. Null when nothing readable was found. */
  business: Business | null;
  fileInfo: { name: string; platform: string; sha256: string; bytes: number }[];
} {
  const flags: ImportFlag[] = [];
  const sales: WatchSale[] = [];
  const dropped: DroppedRow[] = [];
  const fileInfo: { name: string; platform: string; sha256: string; bytes: number }[] = [];

  let tiktokCount = 0;
  let ebayCount = 0;

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

    const result = platform === "TIKTOK" ? parseTikTokFile(file) : parseEbayFile(file);
    if (platform === "TIKTOK") tiktokCount++;
    else ebayCount++;

    sales.push(...result.sales);
    dropped.push(...result.dropped);
    flags.push(...result.flags);
  }

  // Process what is there and say so, rather than blocking the morning (F1).
  if (tiktokCount !== 2) {
    flags.push({
      severity: "warning",
      message: `Expected two TikTok files, got ${tiktokCount}.`,
    });
  }
  if (ebayCount !== 1) {
    flags.push({
      severity: "warning",
      message: `Expected one eBay file, got ${ebayCount}.`,
    });
  }

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

  const boxes = buildBoxes(sales);
  flags.push(...checkIntegrity(sales, boxes));

  // Every file of one morning describes one show day. More than one means two
  // days' exports were dropped in together, which would put the wrong boxes on
  // the wrong date.
  const dates = new Map<DateISO, number>();
  for (const sale of sales) dates.set(sale.showDate, (dates.get(sale.showDate) ?? 0) + 1);
  const ranked = [...dates.entries()].sort((a, b) => b[1] - a[1]);
  const showDate = ranked[0]?.[0] ?? null;

  if (ranked.length > 1) {
    flags.push({
      severity: "blocking",
      message: `These files cover ${ranked.length} different show days (${ranked
        .map(([d, n]) => `${d}: ${n} watches`)
        .join(", ")}). Upload one day at a time.`,
    });
  }
  if (sales.length > 0 && showDate === null) {
    flags.push({ severity: "blocking", message: "No show date could be determined." });
  }

  // Exactly one by the time this returns — anything else is blocking above.
  const business = businesses.size === 1 ? [...businesses][0] : null;

  return { sales, dropped, flags, boxes, showDate, business, fileInfo };
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
  const { sales, dropped, flags, boxes, showDate, business, fileInfo } = readFiles(files);

  /*
    An upload that would take a marketplace away from a day.

    A new upload replaces the day's report: its sales are the ones counted, and
    open boxes it does not mention are removed. 09/11 went in without its eBay
    file, and the natural fix is to upload just that file — which would have
    dropped every TikTok sale and every unpacked TikTok box for the day. So an
    upload has to carry every marketplace the day already has.
  */
  if (showDate !== null && business !== null) {
    /*
      Scoped to this upload's own kind of show.

      A watch report and a diamond report for one day are two separate reports
      and neither replaces the other, so a diamond upload must not be measured
      against what the watch side has loaded. Unscoped, this is what refused
      Flora's diamond file on 09/16: the watch day was already in, the diamond
      file did not contain it, and the guard read that as taking a marketplace
      away.
    */
    const current = await prisma.importBatch.findFirst({
      where: { business, showDate: toDbDate(showDate), status: "OK" },
      orderBy: { uploadedAt: "desc" },
      select: { files: true },
    });
    const lost = platformsDropped(
      platformsOf(current?.files),
      fileInfo.map((f) => f.platform),
    );
    if (lost.length > 0) {
      const names = lost.map((p) => (p === "TIKTOK" ? "TikTok" : "eBay")).join(" and ");
      const whose = business === "WATCH" ? "" : `${BUSINESS_SHORT[business]} `;
      flags.push({
        severity: "blocking",
        message:
          `${showDate} already has its ${whose}${names} report loaded, and these files do not ` +
          `include it. A new upload replaces that report, so this would remove those sales and ` +
          `their unpacked boxes. Upload all of this show's files together.`,
      });
    }
  }

  const blocked = flags.some((f) => f.severity === "blocking");

  if (blocked || showDate === null) {
    // Recorded rather than discarded: a refused upload is the most useful thing
    // to be able to look at afterwards.
    const batch = await prisma.importBatch.create({
      data: {
        business: business ?? "WATCH",
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
      flags,
      watchCount: 0,
      boxCount: 0,
      droppedCount: 0,
      untouchedClosedBoxes: 0,
    };
  }

  const summary = summariseDay(sales, boxes);
  const trackings = boxes.map((b) => b.tracking);

  const written = await prisma.$transaction(
    async (tx) => {
      const batch = await tx.importBatch.create({
        data: {
          business: business ?? "WATCH",
          showDate: toDbDate(showDate),
          status: "OK",
          uploadedById,
          files: fileInfo,
          flags: flags as unknown as object[],
          watchCount: summary.watches,
          boxCount: summary.boxes,
          droppedCount: dropped.length,
        },
        select: { id: true },
      });

      if (sales.length > 0) {
        await tx.salesRecord.createMany({ data: sales.map((s) => toSalesRow(s, batch.id)) });
      }
      if (dropped.length > 0) {
        await tx.importDrop.createMany({ data: dropped.map((d) => toDropRow(d, batch.id)) });
      }

      const existing = await tx.package.findMany({
        where: { trackingNumber: { in: trackings } },
        select: {
          id: true,
          trackingNumber: true,
          status: true,
          items: { select: { id: true, stockNumber: true, scannedQty: true } },
        },
      });
      const byTracking = new Map(existing.map((p) => [p.trackingNumber, p]));
      const closed = existing.filter((p) => p.status !== "OPEN");
      const closedTracking = new Set(closed.map((p) => p.trackingNumber));

      const fresh = boxes.filter((b) => !byTracking.has(b.tracking));
      if (fresh.length > 0) {
        await tx.package.createMany({
          data: fresh.map((b) => ({
            trackingNumber: b.tracking,
            business: business ?? "WATCH",
            platform: b.platform,
            showDate: toDbDate(b.showDate),
            buyer: b.buyer,
            shipToName: b.shipToName,
            shipToState: b.state,
            batchId: batch.id,
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
      for (const box of boxes) {
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
            batchId: batch.id,
            isUnrecognised: false,
          },
        });

        const wanted = new Map(box.items.map((i) => [i.stockNumber, i.expected]));
        for (const item of row.items) {
          const expected = wanted.get(item.stockNumber);
          if (expected === undefined) {
            // Gone from the file. Drop it if untouched; if it was scanned, that
            // happened and the row stays, expecting nothing.
            if (item.scannedQty === 0) {
              await tx.packageItem.delete({ where: { id: item.id } });
            } else {
              await tx.packageItem.update({ where: { id: item.id }, data: { expectedQty: 0 } });
            }
            wanted.delete(item.stockNumber);
            continue;
          }
          await tx.packageItem.update({ where: { id: item.id }, data: { expectedQty: expected } });
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
            })),
          });
        }
      }

      /*
        Boxes that were on this day and are no longer in the file. Only ones
        nobody has touched; the foreign key refuses the rest anyway.

        Scoped to this upload's own kind of show, and that scope is doing real
        work: a day holds a watch report and a diamond report side by side, and
        without it a diamond upload would sweep away every unpacked watch box on
        the same date for the crime of not appearing in a diamond file.
      */
      await tx.package.deleteMany({
        where: {
          business: business ?? "WATCH",
          showDate: toDbDate(showDate),
          status: "OPEN",
          trackingNumber: { notIn: trackings.length > 0 ? trackings : ["-"] },
          scans: { none: {} },
        },
      });

      return { batchId: batch.id, untouchedClosedBoxes: closedTracking.size };
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  return {
    batchId: written.batchId,
    status: "OK",
    showDate,
    flags,
    watchCount: summary.watches,
    boxCount: summary.boxes,
    droppedCount: dropped.length,
    untouchedClosedBoxes: written.untouchedClosedBoxes,
  };
}

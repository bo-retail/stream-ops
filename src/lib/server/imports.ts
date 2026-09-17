import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { BUSINESS_SHORT } from "@/lib/domain/business";
import type { Business } from "@/lib/domain/business";
import { fromDbDate, toDbDate } from "@/lib/domain/dates";
import { buildBoxes, checkIntegrity, summariseDay } from "@/lib/domain/imports/boxes";
import type { Box } from "@/lib/domain/imports/boxes";
import { parseCsv } from "@/lib/domain/imports/csv";
import { parseEbayFile } from "@/lib/domain/imports/ebay";
import { placeEbayFile } from "@/lib/domain/imports/ebay-business";
import type { EbayPlacement } from "@/lib/domain/imports/ebay-business";
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
export function readFiles(
  files: UploadedFile[],
  /**
   * Whose eBay report this is, resolved from the day's schedule by the caller.
   *
   * The file cannot say: eBay names no seller in any of its 82 columns. So a
   * diamond eBay show starts working the day somebody publishes it — nothing
   * here needs editing and no shop needs registering. See `placeEbayFile`.
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

    const result =
      platform === "TIKTOK" ? parseTikTokFile(file) : parseEbayFile(file, ebayBusiness);

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

    This is what makes a diamond eBay show work the day it is published: no code
    change, no shop to register, no deploy. The schedule says diamonds ran eBay
    that day, so the eBay file is theirs.
  */
  const firstPass = readFiles(files);
  const ebayBusiness = firstPass.showDate
    ? await resolveEbayBusiness(firstPass.showDate)
    : { kind: "noShow" as const, business: "WATCH" as const };

  const { sales, dropped, flags, boxes, showDate, business, fileInfo } = readFiles(
    files,
    ebayBusiness.kind === "ambiguous" ? "WATCH" : ebayBusiness.business,
  );

  /*
    Both sold on eBay that day and nothing can say which report this is.

    Cannot happen until diamonds actually start selling there, and when it does
    the honest answer is to stop rather than put one show's sales under the
    other's name and pay the wrong pair.
  */
  if (ebayBusiness.kind === "ambiguous" && fileInfo.some((f) => f.platform === "EBAY")) {
    flags.push({
      severity: "blocking",
      message:
        `${firstPass.showDate} ran an eBay show for both ${ebayBusiness.candidates
          .map((b) => BUSINESS_SHORT[b])
          .join(" and ")}, and an eBay export does not say which seller account it came from. ` +
        `Upload the two days separately, or tell your admin which this one is.`,
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

  /*
    Which line of the day's checklist this upload fills.

    A day is a list of separate exports — one per TikTok show, one per business
    selling on eBay — each produced at a different moment. TikTok's slot comes
    from the show the file was decided to be; eBay has none, because its single
    export covers the whole day however many eBay shows ran.

    One upload is one line. Anything that would fill two at once was refused
    above, so there is exactly one here.
  */
  const lines = new Set(
    sales.map((s) =>
      s.platform === "EBAY" ? "EBAY|" : `TIKTOK|${s.show.endsWith("AM") ? "DAY" : "NIGHT"}`,
    ),
  );

  /*
    An upload may still carry several files at once — three most mornings — and
    each one is its own line. They are written as separate batches so that
    correcting any one of them later touches only that one.

    A file's drops go with its own line. A file whose every row was cancelled
    has no sales and so no line of its own; its drops join the first, which is
    the exceptions list rather than anything anybody is paid from.
  */
  const lineOf = (s: WatchSale) =>
    s.platform === "EBAY" ? "EBAY|" : `TIKTOK|${s.show.endsWith("AM") ? "DAY" : "NIGHT"}`;
  const fileLine = new Map<string, string>();
  for (const s of sales) fileLine.set(s.sourceFile, lineOf(s));

  const keys = [...lines];
  const written = await prisma.$transaction(
    async (tx) => {
      const supersededIds: string[] = [];
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
        const previous = await tx.importBatch.findMany({
          where: {
            business: business ?? "WATCH",
            showDate: toDbDate(showDate),
            status: "OK",
            platform: line.platform,
            slot: line.slot,
          },
          select: { id: true },
        });
        supersededIds.push(...previous.map((b) => b.id));

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
            watchCount: mine.length,
            boxCount: myBoxes.length,
            droppedCount: myDrops.length,
          },
          select: { id: true },
        });
        if (!firstBatchId) firstBatchId = batch.id;

        if (mine.length > 0) {
          await tx.salesRecord.createMany({ data: mine.map((s) => toSalesRow(s, batch.id)) });
        }
        if (myDrops.length > 0) {
          await tx.importDrop.createMany({ data: myDrops.map((d) => toDropRow(d, batch.id)) });
        }
      }

      const batch = { id: firstBatchId };

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
          business: business ?? "WATCH",
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
            batchId: { in: supersededIds },
            status: "OPEN",
            trackingNumber: { notIn: trackings.length > 0 ? trackings : ["-"] },
            scans: { none: {} },
          },
        });
      }

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

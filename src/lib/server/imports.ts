import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { BUSINESS_SHORT, businessOfEbaySeller } from "@/lib/domain/business";
import type { Business } from "@/lib/domain/business";
import { addDays, fromDbDate, toDbDate } from "@/lib/domain/dates";
import { buildBoxes, checkIntegrity, summariseDay } from "@/lib/domain/imports/boxes";
import { carryOver, lateCheckouts, paidLate } from "@/lib/domain/imports/carry-over";
import type { Box } from "@/lib/domain/imports/boxes";
import { parseCsv } from "@/lib/domain/imports/csv";
import { parseEbayFile, readEbaySeller } from "@/lib/domain/imports/ebay";
import { coversNight, shareDiamondDay } from "@/lib/domain/imports/diamond-day";
import { earliestOrderAt, latestOrderAt } from "@/lib/domain/imports/tiktok";
import { hasExtraShow, placeOnExtraShows, replacesAnotherShowsFile } from "@/lib/domain/imports/extra-shows";
import type { TikTokShowWindow } from "@/lib/domain/imports/extra-shows";
import { ebayFallback, placeEbayFile } from "@/lib/domain/imports/ebay-business";
import type { EbayPlacement } from "@/lib/domain/imports/ebay-business";
import { isPlaceholderStock, listingOfNote } from "@/lib/domain/imports/placeholders";
import { parseTikTokFile } from "@/lib/domain/imports/tiktok";
import { defaultShiftTag, detectPlatform, parseShiftTag, slotOfSalesShow, tagDateOf, tagShowWords } from "@/lib/domain/imports/types";
import type { DroppedRow, ImportFlag, WatchSale } from "@/lib/domain/imports/types";
import { slotShort } from "@/lib/domain/types";
import type { DateISO, Slot } from "@/lib/domain/types";
import { getSettings } from "./settings";
import { latestBatchIds } from "./sales-data";

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
    modelNumber: sale.modelNumber ?? "",
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
  /** The extra eBay shows on a date, per business — see `parseEbayFile`. */
  ebayExtraShows: (business: Business, date: DateISO) => readonly Slot[] = () => [],
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
        : (() => {
            const owner = ebaySellerBusiness(file.text) ?? ebayBusiness;
            return parseEbayFile(file, owner, (date) => ebayExtraShows(owner, date));
          })();

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
  /*
    And first, an eBay order checked out after midnight is read back to the show
    its items are tagged with — see `lateCheckouts`. Otherwise one buyer
    checking out late turns the whole morning away as "two show days".
  */
  const checkedOutLate = lateCheckouts(sales);
  // One note per day the orders went back to, so each names its own day.
  const byDay = new Map<string, Set<string>>();
  for (const s of checkedOutLate.redated) {
    byDay.set(s.showDate, (byDay.get(s.showDate) ?? new Set<string>()).add(s.orderRef));
  }
  for (const [day, orders] of byDay) {
    flags.push({
      severity: "info",
      message:
        `eBay order(s) ${[...orders].join(", ")} were checked out after midnight, so eBay dated them the next day. ` +
        `Their items are tagged with ${day}, or they are the only orders dated the next day, so they are counted on ${day} with the rest of the report.`,
    });
  }

  /*
    An eBay item matched to an extra show by its label's own date (a buyer who
    checked out after midnight) keeps that show only if it has now been moved
    back to that date. Otherwise — a listing labelled for yesterday's or
    tomorrow's Early AM, sold today — it would sit on a show today does not
    have and nobody would be paid for it. It is read as AM or PM instead, as it
    always was, and `strayEbayShowLabels` says so.
  */
  const onItsDaysShow = (s: WatchSale): WatchSale => {
    if (s.platform !== "EBAY") return s;
    const slot = slotOfSalesShow(s.show);
    if (slot === "DAY" || slot === "NIGHT" || ebayExtraShows(s.business, s.showDate).includes(slot)) return s;
    const tag = parseShiftTag(s.rawShiftTag);
    return {
      ...s,
      show: tag?.half === "AM" ? ("eBay AM" as const) : ("eBay PM" as const),
      shiftTag: tag ? s.rawShiftTag : defaultShiftTag(s.showDate, "PM"),
      shiftTagValid: tag !== null,
    };
  };
  const carriedOver = carryOver(checkedOutLate.sales.map(onItsDaysShow));
  const { carried } = carriedOver;
  // And again once late payers are settled: one kept on today's report (it
  // shares a label with today's) is today's now, and today may have no such show.
  const kept = carriedOver.kept.map(onItsDaysShow);
  // Its note names the show it now counts towards, not one today does not have.
  const keptToday = carriedOver.keptToday.map((s) => ({
    ...s,
    show: kept.find((k) => k.orderRef === s.orderRef && k.lineRef === s.lineRef)?.show ?? s.show,
  }));
  if (carried.length + keptToday.length + checkedOutLate.redated.length > 0) {
    // The parser's own "two Sale Dates in one file" note is explained by these.
    const late = new Set([...carried, ...keptToday, ...checkedOutLate.redated].map((s) => s.sourceFile));
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
 *
 * Every open box is filed under a current line whose own sales are in it —
 * never simply under whichever upload touched the day last. That is what lets
 * a corrected file find the boxes its line made: on 10/01 the eBay upload was
 * found re-filing the TikTok night boxes as its own, after which a corrected
 * night file could not sweep a cancelled order's box, and it sat open on the
 * floor with nothing to pack.
 */
async function reconcileDayBoxes(
  tx: Prisma.TransactionClient,
  {
    business,
    showDate,
    written,
    supersededIds,
    splitOrigins,
  }: {
    business: Business;
    showDate: DateISO;
    /** The lines just written. A box two lines want goes to one of these first. */
    written: string[];
    /** The uploads just replaced, whose untouched boxes may be swept away. */
    supersededIds: string[];
    splitOrigins: string[];
  },
): Promise<{ untouchedClosedBoxes: number; packedWithout: string[]; packedButGone: string[] }> {

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
      batchId: true,
    },
  });
  const asSource = (r: (typeof dayRows)[number]) => ({
    ...r,
    showDate: fromDbDate(r.showDate),
    show: r.show as WatchSale["show"],
  });
  const dayBoxes = buildBoxes(dayRows.map(asSource));
  const dayTrackings = dayBoxes.map((b) => b.tracking);

  // The current lines of other days, and of the other business, with sales on
  // these labels. Nearly always none.
  const elsewhere = await currentLinesElsewhere(tx, business, showDate, dayTrackings);

  /*
    What goes in each box: everything every current report puts on its label.

    One label is one parcel, whoever's report names it. On 10/11 chrism2525
    bought two watches and a diamond and TikTok put all three on one label, but
    each business's upload built the box from its own sales alone — so the
    packer was shown whichever report went in last, and the rest of the parcel
    was not on the screen at all. A buyer's orders from two days on one label
    lost the earlier day's piece the same way.

    An order is taken once. A late payer can be on two days' exports, and
    counting it from both would ask the packer for a piece nobody bought.
  */
  const sharedRows =
    elsewhere.size === 0
      ? []
      : await tx.salesRecord.findMany({
          where: {
            tracking: { in: [...elsewhere.keys()] },
            batchId: { in: [...new Set([...elsewhere.values()].flatMap((lines) => [...lines]))] },
          },
          orderBy: [{ showDate: "asc" }, { id: "asc" }],
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
            batchId: true,
            batch: { select: { business: true } },
          },
        });
  const sharedOnce = ordersOnce(dayRows, sharedRows);
  /*
    A box any watch report names is a watch box, whichever report made it:
    the packer is shown watch photos, and a watch tag with its model's leading
    zeros (0071 for 71) still finds its line. A diamond's number has letters,
    so the leading-zero match never reaches it.
  */
  const watchLabels = new Set([
    ...(business === "WATCH" ? dayRows.map((r) => r.tracking) : []),
    ...sharedOnce.filter((r) => r.batch.business === "WATCH").map((r) => r.tracking),
  ]);
  const boxBusiness = (tracking: string): Business => (watchLabels.has(tracking) ? "WATCH" : business);
  const contentsOf = new Map(
    buildBoxes([...dayRows, ...sharedOnce].map(asSource)).map((b) => [b.tracking, b.items]),
  );

  // Which current lines have sales in each box — usually one, two for a buyer
  // who bought in both shows on one label.
  const linesWanting = new Map<string, Set<string>>();
  for (const r of dayRows) {
    if (r.tracking === "") continue;
    const lines = linesWanting.get(r.tracking) ?? new Set<string>();
    lines.add(r.batchId);
    linesWanting.set(r.tracking, lines);
  }
  const existing = await tx.package.findMany({
    where: { trackingNumber: { in: dayTrackings } },
    select: {
      id: true,
      trackingNumber: true,
      status: true,
      batchId: true,
      items: { select: { id: true, stockNumber: true, scannedQty: true, expectedQty: true } },
      // The real pieces a packer recorded against placeholder lines, so a
      // report that now names them can be matched to what is in the box —
      // and the pieces scanned straight onto a line, which say how much of
      // that line's count was carried there from a placeholder before.
      scans: {
        where: { kind: { in: ["ITEM_PLACEHOLDER", "ITEM_ACCEPTED", "ITEM_OVERRIDE"] } },
        select: { kind: true, stockNumber: true, note: true },
        orderBy: [{ at: "asc" }, { id: "asc" }],
      },
    },
  });
  const byTracking = new Map(existing.map((p) => [p.trackingNumber, p]));
  const closed = existing.filter((p) => p.status !== "OPEN");
  const closedTracking = new Set(closed.map((p) => p.trackingNumber));

  /*
    Parcels already packed with a piece the report no longer sells them: one
    of two orders on a label cancelled, or refunded after payment (an eBay
    order showing $0 paid). A closed box is never changed, so the refunded
    watch would ship with the paid one. Named, with the piece to take out.
    Not a box marked sent in bulk — it has gone.
  */
  const packedWithExtra = closed
    .filter((p) => p.status !== "CLOSED_UNVERIFIED")
    .flatMap((p) => {
      const wanted = new Map<string, number>();
      for (const i of contentsOf.get(p.trackingNumber) ?? []) wanted.set(i.stockNumber, (wanted.get(i.stockNumber) ?? 0) + i.expected);
      const extra = p.items.filter(
        (i) =>
          !isPlaceholderStock(i.stockNumber) &&
          i.scannedQty > (wanted.get(i.stockNumber) ?? 0) &&
          i.expectedQty > (wanted.get(i.stockNumber) ?? 0),
      );
      return extra.length === 0 ? [] : [`${p.trackingNumber} (take out ${extra.map((i) => i.stockNumber).join(", ")})`];
    });

  /*
    Parcels already packed that a report now adds a piece to.

    A closed box is never changed by an upload. So when the watches on a
    shared label are packed before the diamond report goes up, the box
    closed complete without the diamond, and nothing would ever say so. Named
    here, so whoever uploads can stop that parcel before it leaves.

    Only a stock number the box has no line for at all — a box closed short
    of a watch it knew about is already on the director's list. A piece sold
    under a placeholder is named only later, so a placeholder line, and the
    real pieces scanned against one, are not counted as new.
  */
  const packedWithout = closed
    .filter((p) => {
      const has = new Set([
        ...p.items.map((i) => i.stockNumber),
        ...p.scans.filter((sc) => sc.kind === "ITEM_PLACEHOLDER" && sc.stockNumber).map((sc) => sc.stockNumber!),
      ]);
      return (contentsOf.get(p.trackingNumber) ?? []).some(
        (i) => !has.has(i.stockNumber) && !isPlaceholderStock(i.stockNumber),
      );
    })
    .map((p) => p.trackingNumber);

  /*
    The line a box is filed under: the one it already has while that line is
    current and still has sales in it, so uploading eBay leaves the TikTok
    boxes where they are — and so does a day's upload leave a label the next
    day's report also has. Otherwise a line just written that wants it, and
    otherwise any current line that does — so a box whose night order was
    cancelled passes to the day show that still has a piece in it, and a
    corrected day-show file can sweep it in turn.
  */
  const ownerFor = (tracking: string, now: string | null): string => {
    const lines = linesWanting.get(tracking) ?? new Set<string>();
    if (now !== null && (lines.has(now) || elsewhere.get(tracking)?.has(now))) return now;
    return written.find((id) => lines.has(id)) ?? [...lines][0];
  };

  const fresh = dayBoxes.filter((b) => !byTracking.has(b.tracking));
  if (fresh.length > 0) {
    await tx.package.createMany({
      data: fresh.map((b) => ({
        trackingNumber: b.tracking,
        business: boxBusiness(b.tracking),
        platform: b.platform,
        showDate: toDbDate(b.showDate),
        buyer: b.buyer,
        shipToName: b.shipToName,
        shipToState: b.state,
        batchId: ownerFor(b.tracking, null),
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
        contentsOf.get(b.tracking)!.map((i) => ({
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
        business: boxBusiness(box.tracking),
        batchId: ownerFor(box.tracking, row.batchId),
        isUnrecognised: false,
      },
    });

    const wanted = new Map(contentsOf.get(box.tracking)!.map((i) => [i.stockNumber, i.expected]));

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

      The box is reconciled again by every later upload of its day, and the
      scans stay on record after a piece is carried, so a piece carried once
      must not be carried again. Which ones were is read off the real line:
      every scan straight onto it is on record, so whatever it counts beyond
      those came from a placeholder already. Worked out piece by piece, not
      by how many — the report can rename a placeholder twice, and the second
      time the piece now named may be one that was never carried.
    */
    const scannedOnto = new Map<string, number>();
    for (const scan of row.scans) {
      if (scan.kind === "ITEM_PLACEHOLDER" || !scan.stockNumber) continue;
      scannedOnto.set(scan.stockNumber, (scannedOnto.get(scan.stockNumber) ?? 0) + 1);
    }
    const alreadyCarried = new Map<string, number>();
    for (const item of row.items) {
      const fromPlaceholders = item.scannedQty - (scannedOnto.get(item.stockNumber) ?? 0);
      if (fromPlaceholders > 0) alreadyCarried.set(item.stockNumber, fromPlaceholders);
    }

    const carried = new Map<string, number>();
    const placeholderLeft = new Map<string, number>();
    for (const item of row.items) {
      if (!isPlaceholderStock(item.stockNumber) || wanted.has(item.stockNumber)) continue;
      let left = item.scannedQty;
      for (const scan of row.scans) {
        if (left === 0) break;
        if (scan.kind !== "ITEM_PLACEHOLDER" || !scan.stockNumber) continue;
        if (listingOfNote(scan.note) !== item.stockNumber) continue;
        if (!wanted.has(scan.stockNumber)) continue;
        const done = alreadyCarried.get(scan.stockNumber) ?? 0;
        if (done > 0) {
          alreadyCarried.set(scan.stockNumber, done - 1);
          continue;
        }
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

    Also a box filed under one of the day's current lines that no longer
    has it. Every box is now filed where its sales are (`ownerFor`), so the
    only such boxes are ones filed before 10/01 under whichever upload
    touched the day last — a TikTok night box under eBay — and they are
    swept here rather than left open on the floor.
  */
  const stale = await tx.package.findMany({
    where: {
      batchId: { in: [...supersededIds, ...splitOrigins, ...liveBatchIds] },
      status: "OPEN",
      /*
        Measured against the whole day, not against the file just uploaded.

        A box can hold watches from two shows, filed under either. If a
        buyer's night order is cancelled and the night file re-uploaded, that
        box leaves the night file — but their morning watch is still in it,
        and against this upload alone the box would be deleted out from under
        the packer holding it.
      */
      trackingNumber: { notIn: dayTrackings.length > 0 ? dayTrackings : ["-"] },
      scans: { none: {} },
    },
    select: { id: true, trackingNumber: true, batchId: true },
  });

  /*
    A shared label this line has just let go of, filed under another line.

    A parcel of watches and a diamond is filed under one business's report.
    When the diamond is cancelled and its file corrected, that box is neither
    this day's any more nor filed here, so nothing above would touch it, and
    the packer would still be asked for the cancelled diamond. It is rebuilt
    from the lines that still have it, below, whatever is already in it.
  */
  const letGo =
    supersededIds.length === 0
      ? []
      : (
          await tx.salesRecord.findMany({
            where: { batchId: { in: supersededIds }, tracking: { notIn: ["", ...dayTrackings] } },
            select: { tracking: true },
            distinct: ["tracking"],
          })
        ).map((r) => r.tracking);
  const staleIds = new Set(stale.map((p) => p.id));
  const leftBehind =
    letGo.length === 0
      ? []
      : (
          await tx.package.findMany({
            where: { trackingNumber: { in: letGo }, status: "OPEN" },
            select: { id: true, trackingNumber: true, batchId: true },
          })
        ).filter((p) => !staleIds.has(p.id));

  /*
    And against every other day too: a label this day no longer has may be
    on the next day's report, and that day's packer still needs the box. It
    passes to that day's line, so that day's own correction can sweep it —
    and is made over as that day's box: its date, its buyer, and the pieces
    that day sold, not the ones just cancelled here. Nobody has scanned it,
    so there is nothing in it to keep. A shared label let go of (`leftBehind`)
    may have been scanned; whatever was scanned stays, expecting nothing.
  */
  const wantedElsewhere = await currentLinesElsewhere(
    tx,
    business,
    showDate,
    [...stale, ...leftBehind].map((p) => p.trackingNumber),
  );
  const sweep = stale.filter((p) => !wantedElsewhere.has(p.trackingNumber)).map((p) => p.id);
  const refile = [...stale, ...leftBehind].filter((p) => wantedElsewhere.has(p.trackingNumber));
  if (refile.length > 0) {
    const theirRows = await tx.salesRecord.findMany({
      where: {
        tracking: { in: refile.map((p) => p.trackingNumber) },
        batchId: { in: [...new Set(refile.flatMap((p) => [...wantedElsewhere.get(p.trackingNumber)!]))] },
      },
      orderBy: [{ showDate: "asc" }, { id: "asc" }],
      select: {
        tracking: true, platform: true, buyer: true, shipToName: true, state: true,
        showDate: true, show: true, stockNumber: true, qty: true, orderRef: true, batchId: true,
        batch: { select: { business: true } },
      },
    });
    const theirOnce = ordersOnce([], theirRows);
    const theirWatchLabels = new Set(theirOnce.filter((r) => r.batch.business === "WATCH").map((r) => r.tracking));
    const theirs = new Map(
      buildBoxes(
        theirOnce.map((r) => ({ ...r, showDate: fromDbDate(r.showDate), show: r.show as WatchSale["show"] })),
      ).map((b) => [b.tracking, b]),
    );
    for (const p of refile) {
      const box = theirs.get(p.trackingNumber)!;
      await tx.package.update({
        where: { id: p.id },
        data: {
          platform: box.platform,
          showDate: toDbDate(box.showDate),
          buyer: box.buyer,
          shipToName: box.shipToName,
          shipToState: box.state,
          business: theirWatchLabels.has(p.trackingNumber) ? "WATCH" : "DIAMOND",
          // Left where it is while that line still has it.
          batchId:
            p.batchId !== null && wantedElsewhere.get(p.trackingNumber)!.has(p.batchId)
              ? p.batchId
              : [...wantedElsewhere.get(p.trackingNumber)!][0],
        },
      });
      // Only lines nothing was scanned against, in case a scan landed since.
      await tx.packageItem.deleteMany({
        where: {
          packageId: p.id,
          scannedQty: 0,
          stockNumber: { notIn: box.items.map((i) => i.stockNumber) },
        },
      });
      await tx.packageItem.updateMany({
        where: { packageId: p.id, stockNumber: { notIn: box.items.map((i) => i.stockNumber) } },
        data: { expectedQty: 0 },
      });
      for (const item of box.items) {
        await tx.packageItem.upsert({
          where: { packageId_stockNumber: { packageId: p.id, stockNumber: item.stockNumber } },
          create: { packageId: p.id, stockNumber: item.stockNumber, expectedQty: item.expected },
          update: { expectedQty: item.expected },
        });
      }
    }
  }
  if (sweep.length > 0) {
    await tx.package.deleteMany({ where: { id: { in: sweep }, scans: { none: {} } } });
  }

  /*
    Parcels this line's old file made, already packed — or begun — whose
    orders the new file no longer has: cancelled, or refunded after payment
    (an eBay order showing $0 paid). Such a box is never touched, rightly,
    but a box left alone is a box that ships, and the buyer has had their
    money back. Named, so it is pulled before it goes. Not one another day's
    report still wants.
  */
  const gone =
    supersededIds.length === 0
      ? []
      : await tx.package.findMany({
          where: {
            batchId: { in: supersededIds },
            trackingNumber: { notIn: dayTrackings.length > 0 ? dayTrackings : ["-"] },
            // Not one marked sent in bulk: it has already gone.
            status: { not: "CLOSED_UNVERIFIED" },
            OR: [{ status: { not: "OPEN" } }, { scans: { some: {} } }],
          },
          select: { trackingNumber: true },
        });
  const goneElsewhere =
    gone.length === 0 ? new Map() : await currentLinesElsewhere(tx, business, showDate, gone.map((p) => p.trackingNumber));
  const packedButGone = gone.map((p) => p.trackingNumber).filter((t) => !goneElsewhere.has(t));

  /*
    A shared label this line has just let go of, already packed and closed.

    Watches and a diamond on one label are one box, filed under one of the
    two reports. When one side is cancelled or refunded after the box closed,
    neither check above sees it: the label is no longer this business's day,
    and the box is filed under — or still wanted by — the other line. The
    parcel would ship with the cancelled piece. Named, with the piece to take
    out, measured against what the lines still wanting the label now sell.
    Every earlier upload of the line counts as let go of, so it is named
    again on each later upload of that line — until the parcel is reopened,
    as on the other side (`packedWithExtra`).
  */
  const packedLetGo =
    letGo.length === 0
      ? []
      : await tx.package.findMany({
          where: { trackingNumber: { in: letGo }, status: { notIn: ["OPEN", "CLOSED_UNVERIFIED"] } },
          select: {
            trackingNumber: true,
            items: { select: { stockNumber: true, scannedQty: true, expectedQty: true } },
            scans: {
              where: { kind: "ITEM_PLACEHOLDER" },
              select: { stockNumber: true, note: true },
            },
          },
        });
  const named = new Set(packedButGone);
  const stillWanting = await currentLinesElsewhere(
    tx,
    business,
    showDate,
    packedLetGo.filter((p) => !named.has(p.trackingNumber)).map((p) => p.trackingNumber),
  );
  const stillSold =
    stillWanting.size === 0
      ? []
      : await tx.salesRecord.findMany({
          where: {
            tracking: { in: [...stillWanting.keys()] },
            batchId: { in: [...new Set([...stillWanting.values()].flatMap((lines) => [...lines]))] },
          },
          orderBy: [{ showDate: "asc" }, { id: "asc" }],
          select: {
            tracking: true, platform: true, buyer: true, shipToName: true, state: true,
            showDate: true, show: true, stockNumber: true, qty: true, orderRef: true, batchId: true,
          },
        });
  const stillIn = new Map(
    buildBoxes(
      ordersOnce([], stillSold).map((r) => ({ ...r, showDate: fromDbDate(r.showDate), show: r.show as WatchSale["show"] })),
    ).map((b) => [b.tracking, b.items]),
  );
  const letGoWithExtra = packedLetGo
    .filter((p) => !named.has(p.trackingNumber))
    .flatMap((p) => {
      const wanted = new Map<string, number>();
      for (const i of stillIn.get(p.trackingNumber) ?? []) wanted.set(i.stockNumber, (wanted.get(i.stockNumber) ?? 0) + i.expected);
      const extra: string[] = [];
      for (const i of p.items) {
        const want = wanted.get(i.stockNumber) ?? 0;
        // As above: only a piece the box was asked for, not one put in over it.
        if (i.scannedQty <= want || i.expectedQty <= want) continue;
        if (!isPlaceholderStock(i.stockNumber)) {
          extra.push(i.stockNumber);
          continue;
        }
        // A piece sold under a placeholder carries its own tag: name that,
        // unless what is still sold on the label is that very piece.
        const tags = p.scans
          .filter((sc) => sc.stockNumber && listingOfNote(sc.note) === i.stockNumber)
          .map((sc) => sc.stockNumber!);
        if (tags.length === 0) extra.push(i.stockNumber);
        else extra.push(...tags.filter((tag) => !wanted.has(tag)));
      }
      return extra.length === 0 ? [] : [`${p.trackingNumber} (take out ${[...new Set(extra)].join(", ")})`];
    });

  return {
    untouchedClosedBoxes: closedTracking.size,
    packedWithout,
    packedButGone: [...packedButGone, ...packedWithExtra, ...letGoWithExtra],
  };
}

/** Said at upload: packed parcels whose orders the report no longer has. */
function packedButGoneFlag(labels: string[]): ImportFlag[] {
  if (labels.length === 0) return [];
  return [
    {
      severity: "warning",
      message:
        `${labels.length} parcel(s) were already packed with something this report no longer sells under that label ` +
        `— an order cancelled or refunded after payment, or relabelled: ${labels.slice(0, 5).join(", ")}` +
        `${labels.length > 5 ? ` and ${labels.length - 5} more` : ""}. If not yet shipped, pull each one and check the ` +
        `order in Seller Hub / TikTok before it goes.`,
    },
  ];
}

/** Said at upload: packed parcels a report has since added a piece to. */
function packedWithoutFlag(labels: string[]): ImportFlag[] {
  if (labels.length === 0) return [];
  return [
    {
      severity: "warning",
      message:
        `${labels.length} parcel(s) were packed before this report added a piece to them: ` +
        `${labels.slice(0, 5).join(", ")}${labels.length > 5 ? ` and ${labels.length - 5} more` : ""}. ` +
        `They closed without it — find each one before it ships; the shipping director can reopen it from the log, and the piece is scanned in as an extra.`,
    },
  ];
}

/**
 * The rows of `more` whose orders are in neither `taken` nor an earlier line.
 *
 * A late payer can be on two days' exports. Each order is counted from the
 * first line that has it — `taken` first, then `more` in the order given — so
 * a box asks for its pieces once, not once per report that mentions them.
 */
function ordersOnce<T extends { platform: string; orderRef: string; batchId: string }>(
  taken: readonly { platform: string; orderRef: string }[],
  more: readonly T[],
): T[] {
  const key = (r: { platform: string; orderRef: string }) => `${r.platform}|${r.orderRef}`;
  const lineOf = new Map<string, string | null>(taken.map((r) => [key(r), null]));
  return more.filter((r) => {
    if (!lineOf.has(key(r))) lineOf.set(key(r), r.batchId);
    return lineOf.get(key(r)) === r.batchId;
  });
}

/**
 * Holds one business's show day until this transaction ends.
 *
 * Two uploads of the same day — the night file corrected while somebody else
 * puts up eBay — each read the day's boxes and then change them. Side by side,
 * one deleted a box the other was about to update, and the second upload
 * failed with nothing written. Taken first, this makes the second wait for
 * the first and then read what it left.
 *
 * A late eBay order takes the day before after its own day, never the other
 * way round, and a day is always taken before its eBay report
 * (`lockEbayReport`), so two uploads cannot each be holding what the other
 * waits for.
 */
async function lockDay(tx: Prisma.TransactionClient, business: Business, day: DateISO) {
  /*
    Every upload's boxes, one at a time. One label can be on the watch report
    and the diamond report, or on two days', so two uploads that share no day
    can still be rewriting the same box: side by side, one deleted a line the
    other was about to update, and that whole upload failed. Taken again by
    the same upload it does not wait (advisory locks are re-entrant), and it
    is always first, so no order between the locks below can deadlock.
  */
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('import-boxes'))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`import-day:${business}:${day}`}))`;
}

/**
 * The current lines of other show days — or the other business's — with
 * sales on these labels, by label.
 *
 * One label can be on two days' reports: a buyer's orders from consecutive
 * days sent in one parcel. Reconciling one day must neither take that box off
 * the other day's line nor sweep it while the other day still has it.
 */
async function currentLinesElsewhere(
  tx: Prisma.TransactionClient,
  business: Business,
  showDate: DateISO,
  trackings: string[],
): Promise<Map<string, Set<string>>> {
  const byTracking = new Map<string, Set<string>>();
  if (trackings.length === 0) return byTracking;

  const rows = await tx.salesRecord.findMany({
    where: {
      tracking: { in: trackings },
      batch: { status: "OK", NOT: { business, showDate: toDbDate(showDate) } },
    },
    select: { tracking: true, batchId: true, batch: { select: { business: true, showDate: true } } },
  });
  if (rows.length === 0) return byTracking;

  // Only the newest upload of each line is that line; older ones are history.
  const days = new Map(rows.map((r) => [`${r.batch.business}|${r.batch.showDate.toISOString()}`, r.batch]));
  const batches = await tx.importBatch.findMany({
    where: {
      status: "OK",
      OR: [...days.values()].map((d) => ({ business: d.business, showDate: d.showDate })),
    },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, business: true, showDate: true, platform: true, slot: true },
  });
  const seen = new Set<string>();
  const current = new Set<string>();
  for (const b of batches) {
    const line = `${b.business}|${b.showDate.toISOString()}|${b.platform ?? ""}|${b.slot ?? ""}`;
    if (seen.has(line)) continue;
    seen.add(line);
    current.add(b.id);
  }

  for (const r of rows) {
    if (!current.has(r.batchId)) continue;
    const lines = byTracking.get(r.tracking) ?? new Set<string>();
    lines.add(r.batchId);
    byTracking.set(r.tracking, lines);
  }
  return byTracking;
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
  // The day's boxes first, then its eBay report — the order runImport takes them in.
  await lockDay(tx, business, day);

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
    written: [batch.id],
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
  // Read by the whole name: "TikTok EARLY AM" ends in "AM" and is its own show.
  return sale.platform === "EBAY"
    ? "EBAY|"
    : `TIKTOK|${slotOfSalesShow(sale.show)}`;
}

/**
 * The single line a set of sales belongs to, or null when it is not one line.
 *
 * Null covers both nothing readable and a mix of several, because neither can
 * be recorded against one row of the checklist without being wrong about it.
 */
function linesIn(sales: readonly WatchSale[]): {
  platform: "TIKTOK" | "EBAY";
  slot: string | null;
} | null {
  const keys = new Set(sales.map(lineKey));
  if (keys.size !== 1) return null;
  const [platform, slot] = [...keys][0].split("|");
  return {
    platform: platform as "TIKTOK" | "EBAY",
    slot: (slot || null) as string | null,
  };
}

/**
 * The extra eBay shows running on the days an eBay file can cover — the day,
 * the day before (late payers) and after — keyed "business|date"; and every
 * extra show name the schedule has ever had, to tell a label that names a
 * show from one that merely carries a token.
 *
 * Any release, draft or published, because the boss's plan is the plan either
 * way; never a cancelled show, which sold nothing. The names are eBay shows'
 * only — a TikTok show's name in an eBay label means nothing.
 */
async function ebayExtraShowsAround(day: DateISO): Promise<{ onDay: Map<string, Slot[]>; known: Set<string> }> {
  const [rows, names] = await Promise.all([
    prisma.show.findMany({
      where: {
        platform: "EBAY",
        status: { not: "CANCELLED" },
        slot: { notIn: ["DAY", "NIGHT"] },
        date: { gte: toDbDate(addDays(day, -1)), lte: toDbDate(addDays(day, 1)) },
      },
      select: { business: true, date: true, slot: true },
    }),
    prisma.show.findMany({
      where: { platform: "EBAY", slot: { notIn: ["DAY", "NIGHT"] } },
      distinct: ["slot"],
      select: { slot: true },
    }),
  ]);
  const onDay = new Map<string, Slot[]>();
  for (const r of rows) {
    const key = `${r.business}|${fromDbDate(r.date)}`;
    onDay.set(key, [...(onDay.get(key) ?? []), r.slot]);
  }
  return { onDay, known: new Set(names.map((n) => n.slot)) };
}

/**
 * eBay items whose label looks meant for an extra show but went to the day or
 * night show instead — so the extra show's pair would be paid nothing for them
 * and the day or night pair would be. Said out loud, with the orders, so the
 * schedule or the labels can be put right and the file uploaded again.
 *
 *   - a label naming an extra eBay show that is not on the schedule that day
 *     (`10.15.26 EARLY AM` reads as a day-show tag with a token)
 *   - on a day that has an extra eBay show, a label with any other word before
 *     AM or PM — "10.15.26 Erly AM" — except the TT the team has always used
 */
function strayEbayShowLabels(
  sales: readonly WatchSale[],
  extra: { onDay: ReadonlyMap<string, readonly Slot[]>; known: ReadonlySet<string> },
): ImportFlag[] {
  const ORDINARY = new Set(["AM", "PM", "TT AM", "TT PM"]);
  const notOnDay: WatchSale[] = [];
  const unknown: WatchSale[] = [];
  for (const s of sales) {
    if (s.platform !== "EBAY" || (s.show !== "eBay AM" && s.show !== "eBay PM")) continue;
    const words = tagShowWords(s.rawShiftTag);
    if (words === null || ORDINARY.has(words) || !s.shiftTagValid) continue;
    if (extra.known.has(words)) {
      notOnDay.push(s);
      continue;
    }
    const days = [s.showDate, tagDateOf(s.rawShiftTag)].filter((d): d is DateISO => d !== null);
    if (days.some((d) => (extra.onDay.get(`${s.business}|${d}`) ?? []).length > 0)) unknown.push(s);
  }
  const examples = (list: WatchSale[]) =>
    list
      .slice(0, 3)
      .map((s) => `${s.orderRef} (${s.rawShiftTag})`)
      .join("; ");
  const flags: ImportFlag[] = [];
  if (notOnDay.length > 0) {
    const names = [...new Set(notOnDay.map((s) => tagShowWords(s.rawShiftTag)!))];
    flags.push({
      severity: "warning",
      message:
        `${notOnDay.length} eBay item(s) are labelled for the ${names.join(" / ")} show, but no such eBay show is on ` +
        `the schedule that day, so they were credited to the day or night show instead. Add the show to the schedule ` +
        `(or fix the labels) and upload the eBay file again. ${examples(notOnDay)}`,
    });
  }
  if (unknown.length > 0) {
    flags.push({
      severity: "warning",
      message:
        `${unknown.length} eBay item(s) have a label that is not AM, PM or the name of one of the day's eBay shows, ` +
        `so they were credited to the day or night show by their last word. If they were meant for an extra show, ` +
        `fix the labels (date and show name, like "10.15.26 Early AM") and upload the eBay file again. ${examples(unknown)}`,
    });
  }
  return flags;
}

/** A refusal found only once the day was locked — see `anotherShowsFileGuard`. */
class AnotherShowsFile extends Error {
  constructor(readonly flags: ImportFlag[]) {
    super("another show's file");
  }
}

/**
 * Every TikTok show on a date, in any release — published or still a draft —
 * cancelled ones marked.
 *
 * Drafts count because the hours are the boss's plan either way, and a morning
 * file uploaded before the schedule went out must not be taken for the day
 * show's. Cancelled ones count because a file uploaded while the show was on
 * still sits on its line.
 */
async function tiktokShowsOn(showDate: DateISO): Promise<TikTokShowWindow[]> {
  const rows = await prisma.show.findMany({
    where: { date: toDbDate(showDate), platform: "TIKTOK" },
    select: { business: true, slot: true, startsAt: true, endsAt: true, status: true },
  });
  return rows.map(({ status, ...s }) => ({ ...s, cancelled: status === "CANCELLED" }));
}

/**
 * On a day with an extra TikTok show, the lines this upload would overwrite
 * with a different show's file — see `replacesAnotherShowsFile`. One refusal
 * per such line. Diamonds are left to their own whole-day rules.
 *
 * An extra-show day is one whose schedule has an extra show — draft, running
 * or called off — or whose uploads already hold one's file. The second is for
 * an extra show deleted from the release after its file went in: the day then
 * looks plain again, and a corrected copy of that file would go to the day
 * show by the old rule and replace the day show's file.
 *
 * Asked twice: once before anything is written, so the refusal can be shown,
 * and again inside the write after the day is locked (`db` is then the
 * transaction), so two shows' files uploaded at the same moment cannot both
 * pass the first time and overwrite each other.
 */
async function anotherShowsFileGuard(
  business: Business,
  showDate: DateISO,
  sales: readonly WatchSale[],
  dropped: readonly DroppedRow[],
  db: Prisma.TransactionClient = prisma,
): Promise<ImportFlag[]> {
  if (business !== "WATCH") return [];
  const tiktok = sales.filter((s) => s.platform === "TIKTOK" && s.business === business);
  if (tiktok.length === 0) return [];

  // What this upload brings to each line: its files' orders, sold or cancelled.
  const incoming = new Map<string, Set<string>>();
  const filesOn = new Map<string, Set<string>>();
  for (const s of tiktok) {
    const slot = slotOfSalesShow(s.show);
    (incoming.get(slot) ?? incoming.set(slot, new Set()).get(slot)!).add(s.orderRef);
    (filesOn.get(slot) ?? filesOn.set(slot, new Set()).get(slot)!).add(s.sourceFile);
  }
  for (const d of dropped) {
    for (const [slot, files] of filesOn) if (files.has(d.sourceFile)) incoming.get(slot)!.add(d.orderRef);
  }

  // What each TikTok line holds now: its newest good upload's orders.
  const batches = await db.importBatch.findMany({
    where: { business, showDate: toDbDate(showDate), status: "OK", platform: "TIKTOK" },
    orderBy: { uploadedAt: "desc" },
    select: {
      slot: true,
      files: true,
      sales: { select: { orderRef: true } },
      drops: { select: { orderRef: true } },
    },
  });
  const current = new Map<string, { orders: string[]; files: string[] }>();
  for (const b of batches) {
    if (b.slot === null || current.has(b.slot)) continue;
    current.set(b.slot, {
      orders: [...new Set([...b.sales, ...b.drops].map((r) => r.orderRef))],
      files: [...fileNames(b.files)],
    });
  }
  const holdsExtraFile = [...current.keys()].some((slot) => slot !== "DAY" && slot !== "NIGHT");
  if (!holdsExtraFile) {
    const shows = await db.show.findMany({
      where: { date: toDbDate(showDate), platform: "TIKTOK", business },
      select: { business: true, slot: true, startsAt: true, endsAt: true },
    });
    if (!hasExtraShow(shows, business)) return [];
  }

  const flags: ImportFlag[] = [];
  for (const [slot, orders] of incoming) {
    const now = current.get(slot);
    if (!now) continue;
    // Safe elsewhere: on a line this upload leaves alone, or arriving on another line now.
    const elsewhere = new Set<string>();
    for (const [other, held] of current) if (other !== slot && !incoming.has(other)) held.orders.forEach((o) => elsewhere.add(o));
    for (const [other, arriving] of incoming) if (other !== slot) arriving.forEach((o) => elsewhere.add(o));
    if (!replacesAnotherShowsFile(orders, now.orders, elsewhere)) continue;
    flags.push({
      severity: "blocking",
      message:
        `${[...(filesOn.get(slot) ?? [])].join(", ")} would go on the TikTok ${slotShort(slot)} show, which already has ` +
        `${now.files.join(", ") || "a file"} — and the two share no orders, so they are different shows' exports. ` +
        `Nothing was changed. Check that each show's file is its own export and that the schedule has the right ` +
        `shows and hours for ${showDate}, then upload again. If the file already there belongs to another show, ` +
        `upload both shows' files together in one go and each will go to its own show.`,
    });
  }
  return flags;
}

/**
 * The day's TikTok files, placed on the published schedule's shows when that
 * schedule has an extra show — see `placeOnExtraShows`. `sales` is null when
 * nothing moved, which is every day without one.
 */
async function placeOnScheduledShows(
  sales: WatchSale[],
  files: UploadedFile[],
  showDate: DateISO,
): Promise<{ sales: WatchSale[] | null; flags: ImportFlag[] }> {
  if (!sales.some((s) => s.platform === "TIKTOK")) return { sales: null, flags: [] };
  const shows = await tiktokShowsOn(showDate);
  if (!shows.some((s) => s.slot !== "DAY" && s.slot !== "NIGHT")) return { sales: null, flags: [] };

  const timezone = (await getSettings()).timezone;
  const placed = placeOnExtraShows(
    sales,
    shows,
    (name) => earliestOrderAt(files.find((f) => f.name === name)?.text ?? ""),
    timezone,
  );
  return { sales: placed.sales, flags: placed.flags };
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

  const extraEbay = firstPass.showDate ? await ebayExtraShowsAround(firstPass.showDate) : null;
  const read = readFiles(
    files,
    ebayBusiness.kind === "ambiguous" ? "WATCH" : ebayBusiness.business,
    (business, date) => extraEbay?.onDay.get(`${business}|${date}`) ?? [],
  );
  if (extraEbay) read.flags.push(...strayEbayShowLabels([...read.sales, ...read.carried], extraEbay));
  const { dropped, flags, showDate, business, fileInfo, keptToday } = read;
  let { sales, boxes, carried } = read;

  /*
    A day with an extra TikTok show — the early morning one — places each
    TikTok file on the show its first order falls in, by the published hours.
    Every other day is untouched and reads exactly as it always has.
  */
  if (showDate) {
    const extra = await placeOnScheduledShows(sales, files, showDate);
    flags.push(...extra.flags);
    if (extra.sales !== null) {
      sales = extra.sales;
      boxes = buildBoxes(sales);
    }
  }


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
  /*
    One diamond export for the whole day, on a day of two diamond shows.

    The diamond shop sends one file for the day (10/11: orders 10:33 AM to
    9:42 PM) where the watch shop sends one per show. Such a file is shared
    out between the two shows (`shareDiamondDay`) and written to both diamond
    TikTok lines every time, one of them empty if it has nothing left: a
    corrected copy written to one line only left the other holding the first
    copy's half — paying commission on orders cancelled since, or on the same
    orders twice once the schedule changed.

    What makes it the whole day is what it covers, cancelled orders included:
    placed on the day show by its first order, with any order from the night
    show's scheduled start on (`coversNight`). So a correction whose night orders were all cancelled still replaces
    the night's half, while an export of the morning alone replaces only the
    morning's. With no night show on the schedule any more, a file the day's
    two lines had shared goes to the day show whole, and the night's is emptied.

    Two diamond TikTok files in one upload on such a day are refused: one of
    them is the whole day, and with the other beside it every order in both
    would be paid twice.
  */
  let wholeDay: { file: string; night: Date | null; onNightLine: boolean } | null = null;
  const diamondTiktok = [
    ...new Set(sales.filter((s) => s.business === "DIAMOND" && s.platform === "TIKTOK").map((s) => s.sourceFile)),
  ];
  if (business === "DIAMOND" && showDate && diamondTiktok.length > 0) {
    const [shows, current] = await Promise.all([
      prisma.show.findMany({
        where: {
          date: toDbDate(showDate),
          business: "DIAMOND",
          platform: "TIKTOK",
          status: { not: "CANCELLED" },
          release: { scheduleStatus: "PUBLISHED" },
        },
        select: { slot: true, startsAt: true },
      }),
      prisma.importBatch.findMany({
        where: { business: "DIAMOND", showDate: toDbDate(showDate), status: "OK", platform: "TIKTOK" },
        orderBy: { uploadedAt: "desc" },
        select: { id: true, slot: true, files: true },
      }),
    ]);
    const nightShow = shows.find((sh) => sh.slot === "NIGHT") ?? null;
    // A first upload is shared out only on a day of both shows.
    const night = shows.some((sh) => sh.slot === "DAY") ? nightShow : null;
    const shasOf = (slot: "DAY" | "NIGHT") =>
      ((current.find((b) => b.slot === slot)?.files ?? []) as { sha256?: string }[]).map((f) => f.sha256).filter(Boolean);
    const wasShared = shasOf("DAY").some((sha) => shasOf("NIGHT").includes(sha));
    const placedOnDay = (name: string) => sales.some((s) => s.sourceFile === name && s.show === "TikTok AM");
    const covers = (name: string) =>
      night !== null && coversNight(latestOrderAt(files.find((f) => f.name === name)?.text ?? ""), night.startsAt);
    const whole = diamondTiktok.filter((name) => placedOnDay(name) && covers(name));

    if (diamondTiktok.length > 1 && (whole.length > 0 || wasShared)) {
      flags.push({
        severity: "blocking",
        message:
          `${diamondTiktok.join(" and ")} are both diamond TikTok exports for ${showDate}, and the diamond shop's ` +
          `file covers the whole day — both shows. Uploaded together, every order in both would be counted twice. ` +
          `Upload the whole-day file on its own.`,
      });
    } else if (diamondTiktok.length === 1 && placedOnDay(diamondTiktok[0])) {
      const file = diamondTiktok[0];
      /*
        Whether this file holds the night line's current orders — sold or
        cancelled since. The night line can only be replaced by a file that
        has them, or when it holds nothing yet.
      */
      const nightBatch = current.find((b) => b.slot === "NIGHT");
      const theirs = nightBatch
        ? await prisma.salesRecord.findMany({ where: { batchId: nightBatch.id }, select: { orderRef: true } })
        : [];
      const ours = new Set([
        ...sales.filter((s) => s.sourceFile === file).map((s) => s.orderRef),
        ...dropped.filter((d) => d.sourceFile === file).map((d) => d.orderRef),
      ]);
      const hasNights = theirs.some((r) => ours.has(r.orderRef));

      if (whole.length === 1 && (theirs.length === 0 || hasNights)) {
        // Reaches the night show, and the night line is empty or this file's own.
        // A day export with an order or two past the night's start, uploaded
        // beside a night that already has its orders, stays the day's: written
        // to both, it would have emptied the night of orders it never had.
        wholeDay = { file, night: night!.startsAt, onNightLine: true };
      } else if (wasShared && nightShow === null) {
        wholeDay = { file, night: null, onNightLine: false };
      } else if (wasShared && hasNights) {
        // The day's two lines hold one shared file, and this one no longer
        // reaches the night show — it moved later, or its last orders are gone
        // from the export. It has the night's orders, so it is a correction of
        // the whole day, shared out by the night show's start as it is now.
        // An export of the morning alone has none, and replaces the morning's.
        wholeDay = { file, night: nightShow!.startsAt, onNightLine: true };
      }
    }
  }

  /*
    A refund that arrives on a later day's export.

    A late payer is counted on the day it sold (`carryOver`). If the buyer is
    refunded since, this file shows the order at $0 and drops it — but the
    earlier day's report still holds it as a sale, with its commission and
    its box. Named, with the day to upload again: that day's own corrected
    report is what takes it away.
  */
  const refundedRefs = [...new Set(dropped.filter((d) => d.platform === "EBAY" && d.reason.includes("refunded")).map((d) => d.orderRef))];
  if (showDate && business && refundedRefs.length > 0) {
    // What those days read now — their newest upload per line, not every one
    // ever made — and only this business's: a sales record number belongs
    // to one seller account, and the diamond account counts its own.
    const current = await latestBatchIds(addDays(showDate, -14), addDays(showDate, -1));
    const stillSold = await prisma.salesRecord.findMany({
      where: {
        platform: "EBAY",
        business,
        orderRef: { in: refundedRefs },
        batchId: { in: current.length > 0 ? current : ["-"] },
      },
      select: { orderRef: true, showDate: true },
      distinct: ["orderRef"],
    });
    const byDay = new Map<string, { orderRef: string }[]>();
    for (const r of stillSold) byDay.set(fromDbDate(r.showDate), [...(byDay.get(fromDbDate(r.showDate)) ?? []), r]);
    for (const [day, refs] of byDay) {
      flags.push({
        severity: "warning",
        message:
          `eBay order(s) ${refs.map((r) => r.orderRef).join(", ")} were refunded, but ${day}'s eBay report still ` +
          `counts them as sold — with commission, and a box. Export ${day}'s eBay report again and upload it, so it is ` +
          `taken off that day too.`,
      });
    }
  }

  // On a day with an extra show, never overwrite another show's file.
  if (showDate && business) flags.push(...(await anotherShowsFileGuard(business, showDate, sales, dropped)));

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

  /*
    A whole-day diamond export, shared out between the day's two diamond shows
    by the time each order was placed — decided above, done here, after the
    refusals, so a refused file is still recorded against its own line.
  */
  const forcedLines: string[] = [];
  if (wholeDay) {
    const shared = shareDiamondDay(sales, wholeDay.file, wholeDay.night);
    sales = shared.sales;
    forcedLines.push("TIKTOK|DAY", "TIKTOK|NIGHT");
    flags.push({
      severity: "info",
      message: wholeDay.night
        ? `${wholeDay.file}: one diamond export for both diamond shows. ${shared.night} piece(s) ordered from the ` +
          `night show's start were credited to the night show, the rest to the day show.`
        : `${wholeDay.file}: one diamond export for the day. No diamond night show is on the schedule now, so all ` +
          `of it was credited to the day show, and what the night show was given before was taken off.`,
    });
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
  const lines = new Set([...sales.map(lineKey), ...forcedLines]);

  /*
    An upload may still carry several files at once — three most mornings — and
    each one is its own line. They are written as separate batches so that
    correcting any one of them later touches only that one.

    A file's drops go with its own line. A file whose every row was cancelled
    has no sales and so no line of its own; its drops join the first, which is
    the exceptions list rather than anything anybody is paid from.
  */
  const lineOf = lineKey;
  // A file's lines — two for a diamond export shared between the day's shows.
  // Its cancelled rows go with the first.
  const fileLines = new Map<string, string[]>();
  for (const s of sales) {
    const lines = fileLines.get(s.sourceFile) ?? [];
    if (!lines.includes(lineOf(s))) lines.push(lineOf(s));
    fileLines.set(s.sourceFile, lines);
  }
  // A whole-day diamond file is on both of its lines, empty or not — which is
  // also how its next correction knows to replace both.
  // With no night show, the night line is emptied but the file is not on it:
  // the checklist counts files, and it was not that show's export.
  if (wholeDay) fileLines.set(wholeDay.file, wholeDay.onNightLine ? [...forcedLines] : ["TIKTOK|DAY"]);
  const fileLine = new Map([...fileLines].map(([file, lines]) => [file, lines[0]]));

  const keys = [...lines];
  // What the write found out that nothing could know beforehand.
  const notes: ImportFlag[] = [];
  const written = await prisma.$transaction(
    async (tx) => {
      // Before anything about the day is read.
      if (keys.length > 0) await lockDay(tx, business ?? "WATCH", showDate);

      // Asked again now the day is locked: another upload may have landed
      // since the first asking. Thrown, so nothing below is written.
      if (business) {
        const late = await anotherShowsFileGuard(business, showDate, sales, dropped, tx);
        if (late.some((f) => f.severity === "blocking")) throw new AnotherShowsFile(late);
      }

      const supersededIds: string[] = [];
      const splitOrigins: string[] = [];
      const writtenIds: string[] = [];
      let firstBatchId = "";

      for (const key of keys) {
        const [platform, slot] = key.split("|");
        const line = {
          platform: (platform || null) as "TIKTOK" | "EBAY" | null,
          slot: (slot || null) as string | null,
        };

        const mine = sales.filter((s) => lineOf(s) === key);
        const myDrops = dropped.filter(
          (d) => (fileLine.get(d.sourceFile) ?? keys[0]) === key,
        );
        const myFiles = fileInfo.filter((f) => (fileLines.get(f.name) ?? [keys[0]]).includes(key));
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
        writtenIds.push(batch.id);

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
      const { untouchedClosedBoxes, packedWithout, packedButGone } =
        keys.length > 0
          ? await reconcileDayBoxes(tx, {
              business: business ?? "WATCH",
              showDate,
              written: writtenIds,
              supersededIds,
              splitOrigins,
            })
          : { untouchedClosedBoxes: 0, packedWithout: [] as string[], packedButGone: [] as string[] };

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
        packedWithout,
        packedButGone,
        late,
      };
    },
    { timeout: 120_000, maxWait: 20_000 },
  ).catch((error: unknown) => (error instanceof AnotherShowsFile ? error : Promise.reject(error)));

  // Refused once the day was locked: recorded as any refusal is, nothing written.
  if (written instanceof AnotherShowsFile) {
    const all = [...flags, ...written.flags];
    const refusedLine = linesIn(sales);
    const batch = await prisma.importBatch.create({
      data: {
        business: business ?? "WATCH",
        platform: refusedLine?.platform ?? null,
        slot: refusedLine?.slot ?? null,
        showDate: toDbDate(showDate),
        status: "BLOCKED",
        uploadedById,
        files: fileInfo,
        flags: all as unknown as object[],
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
      flags: all,
      watchCount: 0,
      boxCount: 0,
      droppedCount: 0,
      untouchedClosedBoxes: 0,
    };
  }

  return {
    batchId: written.batchId,
    status: "OK",
    // An all-late report went to the day before, and says so.
    showDate: lateDay ? carried[0].showDate : showDate,
    business,
    flags: [...flags, ...notes, ...packedWithoutFlag(written.packedWithout), ...packedButGoneFlag(written.packedButGone)],
    watchCount: sales.length > 0 ? summary.watches : (written.late?.pieces ?? 0),
    boxCount: sales.length > 0 ? summary.boxes : (written.late?.newBoxes ?? 0),
    droppedCount: dropped.length,
    untouchedClosedBoxes: written.untouchedClosedBoxes,
  };
}

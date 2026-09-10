import "server-only";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { fromDbDate, toDbDate } from "@/lib/domain/dates";
import type { DateISO } from "@/lib/domain/types";
import { getSettings } from "./settings";

/**
 * The shipping log as a workbook.
 *
 * Three sheets, in the order somebody actually reads them:
 *
 *   Summary  — per person per day: boxes, watches, first and last scan
 *   Boxes    — every box, what was expected, what went in, who closed it
 *   Scans    — every scan event, refusals included
 *
 * The Scans sheet is the reason this exists rather than a screenshot of the
 * log. It is the record you hand somebody when a customer says they were sent
 * the wrong watch, and it has to leave the building as a file.
 *
 * Same house style as the sales workbook: Arial, frozen header, filtered.
 */

const BRAND = "FF3F49B8";

function styleHeader(row: ExcelJS.Row) {
  row.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
  row.alignment = { vertical: "middle" };
  row.height = 22;
}

const KIND_LABEL: Record<string, string> = {
  LABEL: "Label scanned",
  ITEM_ACCEPTED: "In the box",
  ITEM_REFUSED: "Refused",
  ITEM_OVERRIDE: "Added against the report",
  CLOSE_COMPLETE: "Closed",
  CLOSE_INCOMPLETE: "Closed incomplete",
  CLOSE_UNVERIFIED: "Marked sent without scanning",
  REOPEN: "Reopened",
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Still open",
  CLOSED_COMPLETE: "Complete",
  CLOSED_INCOMPLETE: "Incomplete",
  // Spelled out rather than abbreviated: this column ends up in front of
  // somebody arguing about a parcel, and "Unverified" alone reads like a
  // system state rather than "nobody checked this one".
  CLOSED_UNVERIFIED: "Sent — not scanned here",
};

export interface ShippingWorkbook {
  buffer: ArrayBuffer;
  filename: string;
  boxes: number;
  scans: number;
}

export async function buildShippingWorkbook(
  from: DateISO,
  to: DateISO,
): Promise<ShippingWorkbook | null> {
  const range = { gte: toDbDate(from), lte: toDbDate(to) };
  const settings = await getSettings();

  const boxes = await prisma.package.findMany({
    where: { showDate: range },
    orderBy: [{ showDate: "asc" }, { closedAt: "asc" }],
    select: {
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
      items: { select: { stockNumber: true, expectedQty: true, scannedQty: true } },
    },
  });

  if (boxes.length === 0) return null;

  const scans = await prisma.scanEvent.findMany({
    where: { package: { showDate: range } },
    orderBy: { at: "asc" },
    select: {
      at: true,
      kind: true,
      stockNumber: true,
      note: true,
      user: { select: { name: true } },
      package: { select: { trackingNumber: true, showDate: true } },
    },
  });

  const stamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = "StreamOps";
  wb.created = new Date();

  /* ---------------------------------------------------------- 1. summary */

  const summary = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 4 }] });
  summary.columns = [
    { header: "Show day", width: 14 },
    { header: "Person", width: 24 },
    { header: "Boxes sent", width: 12 },
    { header: "Watches packed", width: 16 },
    { header: "Incomplete", width: 12 },
    { header: "First scan", width: 12 },
    { header: "Last scan", width: 12 },
  ];

  summary.spliceRows(1, 0, [], [], []);
  summary.mergeCells("A1:G1");
  summary.getCell("A1").value =
    from === to ? `Shipping — ${from}` : `Shipping — ${from} to ${to}`;
  summary.getCell("A1").font = { name: "Arial", bold: true, size: 14 };
  summary.getRow(1).height = 26;
  summary.mergeCells("A2:G2");
  summary.getCell("A2").value =
    "First and last scan bracket when somebody was packing. This is activity, not a timesheet — it knows nothing about breaks.";
  summary.getCell("A2").font = { name: "Arial", italic: true, size: 10, color: { argb: "FF5B6472" } };
  styleHeader(summary.getRow(4));

  // Per person per day, assembled from the scans so somebody who packed
  // nothing but scanned appears too.
  type Cell = { boxes: number; items: number; incomplete: number; first: Date | null; last: Date | null };
  const grid = new Map<string, Cell>();
  const key = (day: DateISO, name: string) => `${day}|${name}`;
  const cell = (k: string) => {
    const found = grid.get(k) ?? { boxes: 0, items: 0, incomplete: 0, first: null, last: null };
    grid.set(k, found);
    return found;
  };

  for (const scan of scans) {
    const c = cell(key(fromDbDate(scan.package.showDate), scan.user.name));
    if (scan.kind === "ITEM_ACCEPTED") c.items++;
    if (!c.first || scan.at < c.first) c.first = scan.at;
    if (!c.last || scan.at > c.last) c.last = scan.at;
  }
  for (const box of boxes) {
    if (!box.closedBy) continue;
    const c = cell(key(fromDbDate(box.showDate), box.closedBy.name));
    c.boxes++;
    if (box.status === "CLOSED_INCOMPLETE") c.incomplete++;
  }

  for (const [k, c] of [...grid.entries()].sort()) {
    const [day, name] = k.split("|");
    summary.addRow([
      day,
      name,
      c.boxes,
      c.items,
      c.incomplete,
      c.first ? clock.format(c.first) : "—",
      c.last ? clock.format(c.last) : "—",
    ]);
  }

  /* ------------------------------------------------------------ 2. boxes */

  const boxSheet = wb.addWorksheet("Boxes", { views: [{ state: "frozen", ySplit: 1 }] });
  boxSheet.columns = [
    { header: "Show day", width: 14 },
    { header: "Tracking", width: 26 },
    { header: "Platform", width: 10 },
    { header: "Buyer", width: 22 },
    { header: "Ship to", width: 24 },
    { header: "State", width: 8 },
    { header: "Expected", width: 10 },
    { header: "Scanned in", width: 12 },
    { header: "Outcome", width: 14 },
    { header: "In any report", width: 14 },
    { header: "Packed by", width: 22 },
    { header: "Closed at", width: 22 },
    { header: "Contents", width: 60 },
  ];
  styleHeader(boxSheet.getRow(1));

  for (const b of boxes) {
    const expected = b.items.reduce((n, i) => n + i.expectedQty, 0);
    const scanned = b.items.reduce((n, i) => n + i.scannedQty, 0);
    boxSheet.addRow([
      fromDbDate(b.showDate),
      b.trackingNumber,
      b.platform === "TIKTOK" ? "TikTok" : "eBay",
      b.buyer,
      b.shipToName,
      b.shipToState,
      expected,
      scanned,
      STATUS_LABEL[b.status] ?? b.status,
      b.isUnrecognised ? "No" : "Yes",
      b.closedBy?.name ?? "",
      b.closedAt ? stamp.format(b.closedAt) : "",
      b.items.map((i) => `${i.stockNumber} ${i.scannedQty}/${i.expectedQty}`).join(", "),
    ]);
  }
  boxSheet.autoFilter = { from: "A1", to: { row: boxes.length + 1, column: 13 } };

  /* ------------------------------------------------------------ 3. scans */

  const scanSheet = wb.addWorksheet("Scans", { views: [{ state: "frozen", ySplit: 1 }] });
  scanSheet.columns = [
    { header: "When", width: 22 },
    { header: "Show day", width: 14 },
    { header: "Tracking", width: 26 },
    { header: "What happened", width: 24 },
    { header: "Watch", width: 18 },
    { header: "By", width: 22 },
    { header: "Note", width: 44 },
  ];
  styleHeader(scanSheet.getRow(1));

  for (const s of scans) {
    scanSheet.addRow([
      stamp.format(s.at),
      fromDbDate(s.package.showDate),
      s.package.trackingNumber,
      KIND_LABEL[s.kind] ?? s.kind,
      s.stockNumber ?? "",
      s.user.name,
      s.note ?? "",
    ]);
  }
  if (scans.length > 0) {
    scanSheet.autoFilter = { from: "A1", to: { row: scans.length + 1, column: 7 } };
  }

  for (const sheet of [summary, boxSheet, scanSheet]) {
    sheet.eachRow((r) =>
      r.eachCell((c) => {
        c.font = { ...(c.font ?? {}), name: "Arial" };
      }),
    );
  }

  const filename =
    from === to
      ? `BO_Retail_Shipping_${from}.xlsx`
      : `BO_Retail_Shipping_${from}_to_${to}.xlsx`;

  return {
    buffer: (await wb.xlsx.writeBuffer()) as ArrayBuffer,
    filename,
    boxes: boxes.length,
    scans: scans.length,
  };
}

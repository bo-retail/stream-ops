import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { formatDate, isDateISO } from "@/lib/domain/dates";
import { formatPeriod, periodFor } from "@/lib/domain/periods";
import { getEntriesInRange, totalsByPerson } from "@/lib/server/timeclock";

/**
 * Clocked hours as a workbook, for the CFO to hand to QuickBooks.
 *
 * Three sheets:
 *   Summary   — one row per person: total hours for the period
 *   Entries   — every shift, for checking a figure back to its source
 *   Import    — the flat layout QuickBooks maps from, nothing else in it
 *
 * Hours are decimal, not `h:mm`. Payroll systems want 7.5, not 7:30, and a
 * colon is the classic way to import a week of nonsense.
 *
 * Open entries are excluded from every total and listed separately on Summary.
 * Exporting a shift with no end time would understate somebody's pay silently;
 * naming it forces the decision before the numbers leave the building.
 */

const BRAND = "FF3F49B8";

/**
 * What each person is, in the words the payroll side uses.
 *
 * It goes in the export because the two are paid on different rules — shipping
 * on the raw clock, streaming clamped to the published shift — and whoever loads
 * this into QuickBooks needs to be able to tell them apart without a second file.
 */
const POSITION: Record<"STREAMING" | "SHIPPING", string> = {
  STREAMING: "Streaming",
  SHIPPING: "Shipping",
};

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
  row.alignment = { vertical: "middle" };
  row.height = 22;
}

/** Minutes as decimal hours, to two places: 450 -> 7.5. */
function decimalHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  if (user.role !== "BOSS") return new NextResponse("Not allowed.", { status: 403 });

  const params = request.nextUrl.searchParams;
  const rawFrom = params.get("from") ?? "";
  const rawTo = params.get("to") ?? "";

  if (rawFrom && !isDateISO(rawFrom)) return new NextResponse("Invalid start date.", { status: 400 });
  if (rawTo && !isDateISO(rawTo)) return new NextResponse("Invalid end date.", { status: 400 });

  // Default to the period containing `from`, so a single date still gives a
  // sensible report rather than one day of it.
  const period = rawFrom && rawTo ? { start: rawFrom, end: rawTo } : periodFor(rawFrom || rawTo);
  if (period.end < period.start) {
    return new NextResponse("The end date is before the start date.", { status: 400 });
  }

  const entries = await getEntriesInRange({ from: period.start, to: period.end });
  const totals = totalsByPerson(entries);
  const open = entries.filter((e) => e.paidMinutes === null);

  const wb = new ExcelJS.Workbook();
  wb.creator = "StreamOps";
  wb.created = new Date();

  /* ----------------------------------------------------- sheet 1: summary */

  const summary = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 4 }] });

  summary.mergeCells("A1:D1");
  const title = summary.getCell("A1");
  title.value = `Hours worked — ${formatPeriod(period)}`;
  title.font = { bold: true, size: 14 };
  summary.getRow(1).height = 26;

  summary.mergeCells("A2:D2");
  summary.getCell("A2").value = `${period.start} to ${period.end} · generated ${new Date().toLocaleString("en-US")}`;
  summary.getCell("A2").font = { italic: true, size: 10, color: { argb: "FF5B6472" } };

  if (open.length > 0) {
    summary.mergeCells("A3:D3");
    const warn = summary.getCell("A3");
    warn.value = `WARNING: ${open.length} shift(s) were never clocked out and are NOT included in these hours.`;
    warn.font = { bold: true, size: 10, color: { argb: "FFB42318" } };
  }

  summary.columns = [
    { key: "name", width: 28 },
    { key: "position", width: 12 },
    { key: "shifts", width: 10 },
    { key: "hours", width: 12 },
    { key: "open", width: 14 },
  ];

  const summaryHeader = summary.getRow(4);
  summaryHeader.values = ["Employee", "Position", "Shifts", "Hours", "Not clocked out"];
  styleHeader(summaryHeader);

  for (const person of totals) {
    const row = summary.addRow({
      name: person.name,
      position: POSITION[person.team],
      shifts: person.entries - person.openEntries,
      hours: decimalHours(person.minutes),
      open: person.openEntries || "",
    });
    row.getCell("hours").numFmt = "0.00";
    if (person.openEntries > 0) row.getCell("open").font = { color: { argb: "FFB42318" } };
  }

  const totalRow = summary.addRow({
    name: "TOTAL",
    position: "",
    shifts: totals.reduce((n, p) => n + p.entries - p.openEntries, 0),
    hours: decimalHours(totals.reduce((n, p) => n + p.minutes, 0)),
    open: open.length || "",
  });
  totalRow.font = { bold: true };
  totalRow.border = { top: { style: "double" } };
  totalRow.getCell("hours").numFmt = "0.00";

  /* ----------------------------------------------------- sheet 2: entries */

  const detail = wb.addWorksheet("Entries", { views: [{ state: "frozen", ySplit: 1 }] });
  detail.columns = [
    { header: "Employee", key: "name", width: 24 },
    { header: "Position", key: "position", width: 12 },
    { header: "Date", key: "date", width: 16 },
    { header: "Clock in", key: "in", width: 10 },
    { header: "Clock out", key: "out", width: 10 },
    { header: "Hours", key: "hours", width: 10 },
    { header: "Entered by", key: "source", width: 14 },
    { header: "Corrected", key: "edited", width: 11 },
    { header: "Note", key: "note", width: 34 },
  ];
  styleHeader(detail.getRow(1));

  for (const entry of entries) {
    const row = detail.addRow({
      name: entry.userName,
      position: POSITION[entry.team],
      date: formatDate(entry.dateISO),
      in: entry.startHM,
      out: entry.endHM ?? "NOT CLOCKED OUT",
      hours: entry.paidMinutes === null ? "" : decimalHours(entry.paidMinutes),
      source: entry.source === "ADMIN" ? "Admin" : "Employee",
      edited: entry.edited ? "Yes" : "",
      note: entry.note ?? "",
    });
    row.getCell("hours").numFmt = "0.00";
    if (entry.paidMinutes === null) {
      row.font = { color: { argb: "FFB42318" } };
    }
  }

  /* ------------------------------------------------------ sheet 3: import */

  // Deliberately plain: one row per person per day, no styling, no totals, no
  // warnings. QuickBooks maps columns by header, and anything extra in the sheet
  // is something to strip out by hand first.
  const importSheet = wb.addWorksheet("Import");
  importSheet.columns = [
    { header: "Employee", key: "employee", width: 28 },
    { header: "Position", key: "position", width: 12 },
    { header: "Date", key: "date", width: 12 },
    { header: "Hours", key: "hours", width: 10 },
  ];

  const byPersonDay = new Map<
    string,
    { employee: string; position: string; date: string; minutes: number }
  >();
  for (const entry of entries) {
    if (entry.paidMinutes === null) continue; // never export an unfinished shift
    const key = `${entry.userId}|${entry.dateISO}`;
    const found = byPersonDay.get(key);
    if (found) found.minutes += entry.paidMinutes;
    else
      byPersonDay.set(key, {
        employee: entry.userName,
        position: POSITION[entry.team],
        date: entry.dateISO,
        minutes: entry.paidMinutes,
      });
  }

  const importRows = [...byPersonDay.values()].sort(
    (a, b) => a.employee.localeCompare(b.employee) || a.date.localeCompare(b.date),
  );

  for (const row of importRows) {
    const added = importSheet.addRow({
      employee: row.employee,
      position: row.position,
      date: row.date,
      hours: decimalHours(row.minutes),
    });
    added.getCell("hours").numFmt = "0.00";
  }

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `hours-${period.start}-to-${period.end}.xlsx`;

  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

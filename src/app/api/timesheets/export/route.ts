import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { formatDate, isDateISO } from "@/lib/domain/dates";
import { formatBps } from "@/lib/domain/payroll";
import { formatPeriod, periodFor } from "@/lib/domain/periods";
import { getPayrollPeriod } from "@/lib/server/payroll";
import {
  getEntriesInRange,
  materialiseScheduledHours,
  totalsByPerson,
} from "@/lib/server/timeclock";

/**
 * The pay period as a workbook: hours, what they are worth, and commission.
 *
 * Five sheets:
 *   Summary     — one row per person: hours, hourly pay, commission, total
 *   Entries     — every shift, for checking an hour back to its source
 *   Commission  — every show somebody was on, what it sold, what it paid them
 *   Import      — the flat hours layout QuickBooks maps from, nothing else in it
 *   Payroll     — one row per person with the money, for whoever pays it
 *
 * Hours are decimal, not `h:mm`. Payroll systems want 7.5, not 7:30, and a
 * colon is the classic way to import a week of nonsense.
 *
 * Open entries are excluded from every total and listed separately on Summary.
 * Exporting a shift with no end time would understate somebody's pay silently;
 * naming it forces the decision before the numbers leave the building. The same
 * goes for anybody who has no rate: their pay comes out as a real-looking zero,
 * so they are called out at the top of the sheet instead.
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

/**
 * Cents as a spreadsheet number, not a string.
 *
 * Whoever opens this will sum a column, and a "$1,234.56" that arrived as text
 * sums to zero without saying so. The dollar sign is a cell format instead.
 */
const MONEY_FMT = '"$"#,##0.00';
const cash = (cents: number): number => cents / 100;

/** The same figure inside a sentence, where a format cannot reach. */
function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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

  // Print anything that has come due before the figures leave the building.
  // Payroll must not be short a show because nobody happened to open a page.
  await materialiseScheduledHours();

  const [entries, payroll] = await Promise.all([
    getEntriesInRange({ from: period.start, to: period.end }),
    getPayrollPeriod(period.start, period.end),
  ]);
  const totals = totalsByPerson(entries);
  const open = entries.filter((e) => e.paidMinutes === null);
  const payById = new Map(payroll.people.map((p) => [p.userId, p]));
  const unrated = payroll.people.filter((p) => p.unrated);

  const wb = new ExcelJS.Workbook();
  wb.creator = "StreamOps";
  wb.created = new Date();

  /* ----------------------------------------------------- sheet 1: summary */

  const summary = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 4 }] });

  summary.mergeCells("A1:I1");
  const title = summary.getCell("A1");
  title.value = `Payroll — ${formatPeriod(period)}`;
  title.font = { bold: true, size: 14 };
  summary.getRow(1).height = 26;

  summary.mergeCells("A2:I2");
  summary.getCell("A2").value =
    `${period.start} to ${period.end} · streamers ${money(payroll.rates.streamerHourlyCents)}/h, ` +
    `shipping ${money(payroll.rates.shippingHourlyCents)}/h, commission ${formatBps(payroll.rates.streamerCommissionBps)} ` +
    `to each person on a show · generated ${new Date().toLocaleString("en-US")}`;
  summary.getCell("A2").font = { italic: true, size: 10, color: { argb: "FF5B6472" } };

  const notes: string[] = [];
  if (open.length > 0) {
    notes.push(`${open.length} shift(s) were never clocked out and are NOT in these hours.`);
  }
  if (unrated.length > 0) {
    notes.push(
      `NO RATE SET for ${unrated.map((p) => p.name).join(", ")} — their pay reads as zero.`,
    );
  }
  if (payroll.unattributed.length > 0) {
    const cents = payroll.unattributed.reduce((n, s) => n + s.netRevenueCents, 0);
    notes.push(
      `${money(cents)} of sales is tagged for shows nobody is rostered on — no commission was paid on it.`,
    );
  }
  if (notes.length > 0) {
    summary.mergeCells("A3:I3");
    const warn = summary.getCell("A3");
    warn.value = `WARNING: ${notes.join(" ")}`;
    warn.font = { bold: true, size: 10, color: { argb: "FFB42318" } };
    warn.alignment = { wrapText: true, vertical: "middle" };
    summary.getRow(3).height = 30;
  }

  summary.columns = [
    { key: "name", width: 26 },
    { key: "position", width: 18 },
    { key: "shifts", width: 8 },
    { key: "hours", width: 9 },
    { key: "rate", width: 10 },
    { key: "hourlyPay", width: 13 },
    { key: "commission", width: 13 },
    { key: "total", width: 13 },
    { key: "open", width: 15 },
  ];

  const summaryHeader = summary.getRow(4);
  summaryHeader.values = [
    "Employee",
    "Position",
    "Shifts",
    "Hours",
    "Rate",
    "Hourly pay",
    "Commission",
    "TOTAL PAY",
    "Not clocked out",
  ];
  styleHeader(summaryHeader);

  for (const person of totals) {
    const pay = payById.get(person.userId);
    const row = summary.addRow({
      name: person.name,
      position: pay?.position ?? POSITION[person.team],
      shifts: person.entries - person.openEntries,
      hours: decimalHours(person.minutes),
      rate: cash(pay?.hourlyRateCents ?? 0),
      hourlyPay: cash(pay?.hourlyPayCents ?? 0),
      commission: cash(pay?.commissionCents ?? 0),
      total: cash(pay?.totalCents ?? 0),
      open: person.openEntries || "",
    });
    row.getCell("hours").numFmt = "0.00";
    for (const key of ["rate", "hourlyPay", "commission", "total"]) {
      row.getCell(key).numFmt = MONEY_FMT;
    }
    row.getCell("total").font = { bold: true };
    if (person.openEntries > 0) row.getCell("open").font = { color: { argb: "FFB42318" } };
    if (pay?.unrated) row.getCell("rate").font = { bold: true, color: { argb: "FFB42318" } };
  }

  const totalRow = summary.addRow({
    name: "TOTAL",
    position: "",
    shifts: totals.reduce((n, p) => n + p.entries - p.openEntries, 0),
    hours: decimalHours(totals.reduce((n, p) => n + p.minutes, 0)),
    rate: "",
    hourlyPay: cash(payroll.totals.hourlyPayCents),
    commission: cash(payroll.totals.commissionCents),
    total: cash(payroll.totals.totalCents),
    open: open.length || "",
  });
  totalRow.font = { bold: true };
  totalRow.border = { top: { style: "double" } };
  totalRow.getCell("hours").numFmt = "0.00";
  for (const key of ["hourlyPay", "commission", "total"]) {
    totalRow.getCell(key).numFmt = MONEY_FMT;
  }

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

  /* -------------------------------------------------- sheet 3: commission */

  // Every show somebody was on, what it sold, and what that paid them. This is
  // the sheet somebody opens when they want to know why a commission figure is
  // what it is — and the one that shows the same show paying two people.
  const commission = wb.addWorksheet("Commission", { views: [{ state: "frozen", ySplit: 1 }] });
  commission.columns = [
    { header: "Employee", key: "name", width: 26 },
    { header: "Show", key: "show", width: 26 },
    { header: "Show sold", key: "sales", width: 14 },
    { header: "Rate", key: "rate", width: 10 },
    { header: "Commission", key: "commission", width: 14 },
  ];
  styleHeader(commission.getRow(1));

  for (const person of payroll.people) {
    for (const show of person.shows) {
      const row = commission.addRow({
        name: person.name,
        show: show.label,
        sales: cash(show.netRevenueCents),
        rate: formatBps(show.bps),
        commission: cash(show.commissionCents),
      });
      row.getCell("sales").numFmt = MONEY_FMT;
      row.getCell("commission").numFmt = MONEY_FMT;
    }
  }

  if (payroll.unattributed.length > 0) {
    commission.addRow({});
    const heading = commission.addRow({ name: "NOT PAID TO ANYBODY" });
    heading.font = { bold: true, color: { argb: "FFB42318" } };
    for (const show of payroll.unattributed) {
      const row = commission.addRow({
        name: "—",
        show: show.label,
        sales: cash(show.netRevenueCents),
        rate: "",
        commission: cash(0),
      });
      row.getCell("sales").numFmt = MONEY_FMT;
      row.getCell("commission").numFmt = MONEY_FMT;
      row.font = { color: { argb: "FFB42318" } };
    }
  }

  /* ------------------------------------------------------ sheet 4: import */

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

  /* ----------------------------------------------------- sheet 5: payroll */

  // What actually gets paid, one line each, nothing else on the sheet. The
  // Import sheet above is hours for QuickBooks; this is money for whoever runs
  // the payment.
  const pay = wb.addWorksheet("Payroll");
  pay.columns = [
    { header: "Employee", key: "employee", width: 28 },
    { header: "Position", key: "position", width: 18 },
    { header: "Hours", key: "hours", width: 10 },
    { header: "Hourly pay", key: "hourlyPay", width: 13 },
    { header: "Commission", key: "commission", width: 13 },
    { header: "Total", key: "total", width: 13 },
  ];

  for (const person of payroll.people) {
    const row = pay.addRow({
      employee: person.name,
      position: person.position,
      hours: decimalHours(person.minutes),
      hourlyPay: cash(person.hourlyPayCents),
      commission: cash(person.commissionCents),
      total: cash(person.totalCents),
    });
    row.getCell("hours").numFmt = "0.00";
    for (const key of ["hourlyPay", "commission", "total"]) {
      row.getCell(key).numFmt = MONEY_FMT;
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `payroll-${period.start}-to-${period.end}.xlsx`;

  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

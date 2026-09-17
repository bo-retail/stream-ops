import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { BUSINESS_SHORT } from "@/lib/domain/business";
import { formatDate, isDateISO, minutesToHours } from "@/lib/domain/dates";
import { formatPeriod, periodFor } from "@/lib/domain/periods";
import { PLATFORM_SHORT, SLOT_SHORT } from "@/lib/domain/types";
import { getEmployeePeriod } from "@/lib/server/schedule";
import { getWeekContext } from "@/lib/server/settings";

/**
 * One person's own shifts for a period, as a spreadsheet.
 *
 * Deliberately separate from the boss's schedule export rather than a filtered
 * version of it. That one is the whole team's rota, and the guard on it is
 * "are you an admin". This one is "your own shifts, and only ever your own" —
 * there is no user parameter to tamper with, because it reads the id straight
 * off the session. A streamer cannot ask for somebody else's copy.
 *
 * Only published schedules appear, which `getEmployeePeriod` already enforces:
 * a draft can still be rearranged, and a spreadsheet is exactly the kind of
 * thing that outlives the draft it came from.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });

  const raw = request.nextUrl.searchParams.get("period") ?? "";
  if (raw && !isDateISO(raw)) return new NextResponse("Invalid period.", { status: 400 });
  const { today } = await getWeekContext();
  const period = periodFor(raw || today);

  const { shows } = await getEmployeePeriod(user.id, period.start);

  const wb = new ExcelJS.Workbook();
  wb.creator = "StreamOps";
  wb.created = new Date();

  const sheet = wb.addWorksheet("My shifts", { views: [{ state: "frozen", ySplit: 4 }] });

  sheet.mergeCells("A1:F1");
  const title = sheet.getCell("A1");
  title.value = `${user.name} — shifts for ${formatPeriod(period)}`;
  title.font = { bold: true, size: 14 };
  sheet.getRow(1).height = 26;

  sheet.mergeCells("A2:F2");
  const sub = sheet.getCell("A2");
  const running = shows.filter((s) => s.status === "SCHEDULED");
  sub.value =
    running.length === 0
      ? "No shifts on the published schedule for this period."
      : `${running.length} shift${running.length === 1 ? "" : "s"}. Cancelled shows are listed but not counted.`;
  sub.font = { italic: true, size: 10, color: { argb: "FF5B6472" } };

  sheet.columns = [
    { key: "date", width: 22 },
    { key: "show", width: 16 },
    { key: "start", width: 10 },
    { key: "end", width: 10 },
    { key: "hours", width: 9 },
    { key: "with", width: 24 },
  ];

  const header = sheet.getRow(4);
  header.values = ["Date", "Show", "Start", "End", "Hours", "Working with"];
  header.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3F49B8" } };
  header.alignment = { vertical: "middle" };
  header.height = 22;

  let totalMinutes = 0;

  for (const show of shows) {
    const minutes = Math.round((show.endsAt.getTime() - show.startsAt.getTime()) / 60_000);
    const cancelled = show.status === "CANCELLED";
    if (!cancelled) totalMinutes += minutes;

    const row = sheet.addRow({
      date: formatDate(show.dateISO, "long"),
      // Named for both kinds, not just diamonds. A printed sheet is read away
      // from the app by somebody who cannot hover anything to find out which
      // shop a shift was for.
      show: `${BUSINESS_SHORT[show.business]} ${PLATFORM_SHORT[show.platform]} ${SLOT_SHORT[show.slot]}`,
      start: show.startHM,
      end: show.endHM,
      // A cancelled shift is shown so nobody wonders where it went, but it
      // contributes nothing — writing hours against it would invite adding the
      // column up by hand and getting a different answer to the total below.
      hours: cancelled ? "—" : Number(minutesToHours(minutes)),
      with: show.alongside?.name ?? "—",
    });

    if (!cancelled) row.getCell("hours").numFmt = "0.00";
    if (cancelled) {
      row.font = { italic: true, color: { argb: "FF5B6472" } };
      row.getCell("show").value = `${row.getCell("show").value} (cancelled)`;
    }
  }

  if (shows.length > 0) {
    const total = sheet.addRow({
      date: "TOTAL",
      hours: Number(minutesToHours(totalMinutes)),
      with: `${running.length} shift${running.length === 1 ? "" : "s"}`,
    });
    total.font = { bold: true };
    total.border = { top: { style: "double" } };
    total.getCell("hours").numFmt = "0.00";
  }

  const buffer = await wb.xlsx.writeBuffer();
  // The person's own name is in the filename so a folder of these stays sorted
  // and readable, rather than six copies of "schedule.xlsx".
  const safeName = user.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  const filename = `${safeName}-shifts-${period.start}-to-${period.end}.xlsx`;

  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { BUSINESS_LABEL } from "@/lib/domain/business";
import { formatDate, minutesToHours } from "@/lib/domain/dates";
import { DAILY_SHOWS, PLATFORM_SHORT, SLOT_SHORT } from "@/lib/domain/types";
import { getReleaseView } from "@/lib/server/schedule";

/**
 * The release schedule as a real Excel workbook.
 *
 * Three sheets, because the same schedule gets used three ways:
 *   Schedule   — the wall-chart grid, for printing and pinning up
 *   Shows      — one row per show, filterable and sortable
 *   Per person — who is on what, for a quick sense of the week's load
 */

const BRAND = "FF3F49B8";
const MUTED_FILL = "FFF6F7F9";
const EMPTY_FILL = "FFFEE2E2";
const OFF_FILL = "FFEFF1F4";

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
  row.alignment = { vertical: "middle" };
  row.height = 22;
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  if (user.role !== "BOSS") return new NextResponse("Not allowed.", { status: 403 });

  const releaseId = request.nextUrl.searchParams.get("release") ?? "";
  if (!releaseId) return new NextResponse("Which release?", { status: 400 });

  const view = await getReleaseView(releaseId);
  if (!view) return new NextResponse("No such release.", { status: 404 });

  const wb = new ExcelJS.Workbook();
  wb.creator = "StreamOps";
  wb.created = new Date();

  /* -------------------------------------------------------- sheet 1: grid */

  const grid = wb.addWorksheet("Schedule", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 4 }],
  });

  grid.mergeCells("A1:E1");
  const title = grid.getCell("A1");
  // The kind of show first, because a release covers exactly one and the name
  // is whatever somebody typed. A printed rota headed only "late September"
  // does not say whose shows are on it.
  title.value = `${BUSINESS_LABEL[view.release.business]} schedule — ${view.release.label}`;
  title.font = { bold: true, size: 14 };
  grid.getRow(1).height = 26;

  grid.mergeCells("A2:E2");
  const sub = grid.getCell("A2");
  sub.value =
    view.release.scheduleStatus === "PUBLISHED"
      ? `Published version ${view.release.version}${view.release.publishedAt ? ` on ${view.release.publishedAt.toLocaleDateString("en-US")}` : ""}`
      : "DRAFT — not yet published to the team";
  sub.font = { italic: true, size: 10, color: { argb: "FF5B6472" } };

  // One column per show: TikTok Day, TikTok Night, eBay Day, eBay Night.
  const columns = DAILY_SHOWS.map(({ platform, slot }) => ({ platform, slot }));

  grid.columns = [
    { key: "day", width: 20 },
    ...columns.map((_, i) => ({ key: `c${i}`, width: 30 })),
  ];

  const headerTop = grid.getRow(3);
  headerTop.getCell(1).value = "Day";
  columns.forEach((c, i) => {
    headerTop.getCell(i + 2).value = PLATFORM_SHORT[c.platform];
  });
  styleHeader(headerTop);

  const headerBottom = grid.getRow(4);
  columns.forEach((c, i) => {
    headerBottom.getCell(i + 2).value = `${SLOT_SHORT[c.slot]} show`;
  });
  headerBottom.font = { bold: true, size: 10 };
  headerBottom.fill = { type: "pattern", pattern: "solid", fgColor: { argb: MUTED_FILL } };

  for (const dateISO of view.dates) {
    const row = grid.addRow({ day: formatDate(dateISO, "long") });
    row.getCell(1).font = { bold: true };
    row.alignment = { vertical: "top", wrapText: true };

    columns.forEach((c, i) => {
      const cell = row.getCell(i + 2);
      const show = view.shows.find(
        (s) => s.dateISO === dateISO && s.platform === c.platform && s.slot === c.slot,
      );

      if (!show) {
        cell.value = "—";
        cell.font = { color: { argb: "FF9AA1AC" } };
        return;
      }

      if (show.status === "CANCELLED") {
        cell.value = `CANCELLED${show.notes ? `\n${show.notes}` : ""}`;
        cell.font = { italic: true, color: { argb: "FF5B6472" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: OFF_FILL } };
        return;
      }

      // Two names, one per line. Empty seats say so rather than leaving a blank
      // that could be read as "we forgot to print it".
      const names = [0, 1].map((i) => show.assignments[i]?.userName ?? "— nobody —");
      cell.value = `${show.startHM}–${show.endHM}\n${names[0]}\n${names[1]}`;

      if (show.assignments.length < 2) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: EMPTY_FILL } };
      }
    });

    row.height = 52;
  }

  /* ------------------------------------------------------- sheet 2: shows */

  const shows = wb.addWorksheet("Shows", { views: [{ state: "frozen", ySplit: 1 }] });
  shows.columns = [
    { header: "Date", key: "date", width: 16 },
    { header: "Platform", key: "platform", width: 10 },
    { header: "Show", key: "slot", width: 8 },
    { header: "Start", key: "start", width: 8 },
    { header: "End", key: "end", width: 8 },
    { header: "Hours", key: "hours", width: 8 },
    { header: "Person 1", key: "person1", width: 22 },
    { header: "Person 2", key: "person2", width: 22 },
    { header: "Status", key: "status", width: 12 },
    { header: "Notes", key: "notes", width: 28 },
  ];
  styleHeader(shows.getRow(1));

  for (const show of view.shows) {
    const row = shows.addRow({
      date: formatDate(show.dateISO),
      platform: PLATFORM_SHORT[show.platform],
      slot: SLOT_SHORT[show.slot],
      start: show.startHM,
      end: show.endHM,
      hours: Number(minutesToHours(show.minutes)),
      person1: show.assignments[0]?.userName ?? "NOBODY",
      person2: show.assignments[1]?.userName ?? "NOBODY",
      status: show.status === "CANCELLED" ? "Cancelled" : "Running",
      notes: show.notes ?? "",
    });

    if (show.status === "CANCELLED") {
      row.font = { italic: true, color: { argb: "FF5B6472" } };
    } else if (show.assignments.length < 2) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: EMPTY_FILL } };
    }
  }

  /* -------------------------------------------------- sheet 3: per person */

  const per = wb.addWorksheet("Per person", { views: [{ state: "frozen", ySplit: 1 }] });
  per.columns = [
    { header: "Person", key: "name", width: 24 },
    { header: "Shows", key: "shows", width: 8 },
    { header: "Hours", key: "hours", width: 8 },
    { header: "Working with", key: "partners", width: 34 },
    { header: "Which shows", key: "detail", width: 60 },
  ];
  styleHeader(per.getRow(1));

  for (const person of view.streamers) {
    const theirs = view.shows.filter(
      (show) =>
        show.status === "SCHEDULED" && show.assignments.some((a) => a.userId === person.id),
    );

    const minutes = theirs.reduce((m, show) => m + show.minutes, 0);
    const partners = [
      ...new Set(
        theirs.flatMap((show) =>
          show.assignments.filter((a) => a.userId !== person.id).map((a) => a.userName),
        ),
      ),
    ].sort();

    const row = per.addRow({
      name: person.name,
      shows: theirs.length,
      hours: Number(minutesToHours(minutes)),
      partners: partners.join(", "),
      detail: theirs
        .map(
          (show) =>
            `${formatDate(show.dateISO, "short")} ${PLATFORM_SHORT[show.platform]} ${SLOT_SHORT[show.slot]}`,
        )
        .join(", "),
    });
    row.alignment = { vertical: "top", wrapText: true };
    if (theirs.length === 0) row.font = { color: { argb: "FF9AA1AC" } };
  }

  const totals = per.addRow({
    name: "TOTAL",
    shows: view.validation.filledSeats,
    hours: Number(
      minutesToHours(
        view.shows
          .filter((s) => s.status === "SCHEDULED")
          .reduce((m, s) => m + s.minutes * s.assignments.length, 0),
      ),
    ),
    detail: `${view.validation.filledSeats} of ${view.validation.totalSeats} seats filled`,
  });
  totals.font = { bold: true };
  totals.border = { top: { style: "double" } };

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `schedule-${view.release.startDate}-to-${view.release.endDate}.xlsx`;

  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

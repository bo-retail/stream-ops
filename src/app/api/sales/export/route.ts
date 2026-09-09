import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { isDateISO } from "@/lib/domain/dates";
import { buildSalesWorkbook } from "@/lib/server/sales-workbook";
import type { DateISO } from "@/lib/domain/types";

/**
 * The sales workbook, downloaded.
 *
 * `?date=YYYY-MM-DD` for one show day, or `?from=&to=` for a range. The
 * workbook itself is built in `lib/server/sales-workbook`, which is where the
 * format and the formulas live; this is the part that decides who may ask.
 *
 * Boss only. The shipping director loads the files and packs against them, but
 * what the business took is not her screen.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  if (user.role !== "BOSS") return new NextResponse("Not allowed.", { status: 403 });

  const params = request.nextUrl.searchParams;
  const rawDate = params.get("date") ?? "";
  const rawFrom = params.get("from") ?? "";
  const rawTo = params.get("to") ?? "";

  for (const [name, value] of [
    ["date", rawDate],
    ["from", rawFrom],
    ["to", rawTo],
  ]) {
    if (value && !isDateISO(value)) return new NextResponse(`Invalid ${name}.`, { status: 400 });
  }

  const from: DateISO = rawFrom || rawDate;
  const to: DateISO = rawTo || rawDate || rawFrom;
  if (!from || !to) return new NextResponse("Give a date, or a from and to.", { status: 400 });
  if (to < from) return new NextResponse("The end date is before the start date.", { status: 400 });

  const workbook = await buildSalesWorkbook(from, to);
  if (!workbook) {
    return new NextResponse(
      `No sales reports have been loaded for ${from === to ? from : `${from} to ${to}`}.`,
      { status: 404 },
    );
  }

  return new NextResponse(workbook.buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${workbook.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

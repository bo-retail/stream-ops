import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { isDateISO } from "@/lib/domain/dates";
import { buildShippingWorkbook } from "@/lib/server/shipping-workbook";
import type { DateISO } from "@/lib/domain/types";

/**
 * The shipping log, downloaded.
 *
 * `?date=YYYY-MM-DD` for one day, or `?from=&to=` for a range.
 *
 * Open to the shipping director as well as the boss — unlike the sales
 * workbook. This is her own record of what her floor sent and who sent it, and
 * the Scans sheet is what she needs in hand when a customer disputes a parcel.
 * It carries no money.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });

  const allowed = user.role === "BOSS" || (user.role === "MANAGER" && user.team === "SHIPPING");
  if (!allowed) return new NextResponse("Not allowed.", { status: 403 });

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

  const workbook = await buildShippingWorkbook(from, to);
  if (!workbook) {
    return new NextResponse(
      `No boxes exist for ${from === to ? from : `${from} to ${to}`}.`,
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

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { todayISO } from "@/lib/domain/dates";
import { receivingSheet } from "@/lib/server/receive";
import { getSettings } from "@/lib/server/settings";

/** The receiving sheet: the starting count's columns, empty. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  const allowed = user.role === "BOSS" || (user.role === "MANAGER" && user.team === "SHIPPING");
  if (!allowed) return new NextResponse("Not allowed.", { status: 403 });

  const today = todayISO((await getSettings()).timezone);
  const buffer = await receivingSheet(today);
  return new NextResponse(buffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="receiving-${today}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}

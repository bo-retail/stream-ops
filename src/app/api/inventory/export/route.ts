import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { todayISO } from "@/lib/domain/dates";
import { bringStockUpToDateQuietly, getStartDate } from "@/lib/server/deduction";
import { inventoryWorkbook, rangeOf } from "@/lib/server/inventory-export";
import { getSettings } from "@/lib/server/settings";

/** Inventory as an Excel file: stock now, and every sale taken off. */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  const allowed = user.role === "BOSS" || (user.role === "MANAGER" && user.team === "SHIPPING");
  if (!allowed) return new NextResponse("Not allowed.", { status: 403 });

  // The latest sales taken off first, so the file matches the screen.
  const run = await bringStockUpToDateQuietly(user.id);
  const { timezone } = await getSettings();
  const today = todayISO(timezone);
  const params = new URL(request.url).searchParams;
  const range = rangeOf(await getStartDate(), today, params.get("from") ?? undefined, params.get("to") ?? undefined);
  const buffer = await inventoryWorkbook(range, today, run, timezone);
  return new NextResponse(buffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="inventory-${today}-sold-${range.from}-to-${range.to}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}

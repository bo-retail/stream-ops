import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { isDateISO } from "@/lib/domain/dates";
import { DAY_PLAN_OFF_MESSAGE, DAY_PLAN_ON } from "@/lib/domain/features";
import { bringStockUpToDateQuietly } from "@/lib/server/deduction";
import { planFile, type PlanFileKind } from "@/lib/server/show-plan";

const KINDS: PlanFileKind[] = ["ebay-am", "ebay-pm", "tiktok"];

/**
 * One of the day's upload files, in the platform's own template: the eBay file
 * for the AM or the PM show, or the day's one TikTok file. Made from the saved
 * plan and the shelf as it is when downloaded.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ date: string; file: string }> }) {
  if (!DAY_PLAN_ON) return new NextResponse(DAY_PLAN_OFF_MESSAGE, { status: 404 });
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  const allowed = user.role === "BOSS" || (user.role === "MANAGER" && user.team === "SHIPPING");
  if (!allowed) return new NextResponse("Not allowed.", { status: 403 });
  const { date, file } = await params;
  if (!isDateISO(date) || !KINDS.includes(file as PlanFileKind)) return new NextResponse("No such file.", { status: 404 });

  // The latest sales and packing first, so nothing sold is listed again.
  await bringStockUpToDateQuietly(user.id, { ifChanged: true });
  const made = await planFile(user.id, date, file as PlanFileKind);
  if (!made) return new NextResponse("Save the day's plan first; the files are made from it.", { status: 409 });
  return new NextResponse(Buffer.from(made.bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${made.name}"`,
      "cache-control": "no-store",
    },
  });
}

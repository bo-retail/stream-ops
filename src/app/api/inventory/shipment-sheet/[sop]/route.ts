import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { shipmentCountSheet } from "@/lib/server/receiving";

/** A shipment's count sheet, built from its list as it stands. */
export async function GET(_req: Request, { params }: { params: Promise<{ sop: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  const allowed = user.role === "BOSS" || (user.role === "MANAGER" && user.team === "SHIPPING");
  if (!allowed) return new NextResponse("Not allowed.", { status: 403 });

  const { sop } = await params;
  const buffer = await shipmentCountSheet(sop);
  if (!buffer) return new NextResponse("No such shipment.", { status: 404 });
  const name = sop.replace(/[^A-Za-z0-9-]/g, "");
  return new NextResponse(buffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="shipment-count-${name}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}

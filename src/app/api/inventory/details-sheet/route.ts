import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { detailsSheet } from "@/lib/server/product-details";

/** The product details sheet, with every model as it stands now. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  const allowed = user.role === "BOSS" || (user.role === "MANAGER" && user.team === "SHIPPING");
  if (!allowed) return new NextResponse("Not allowed.", { status: 403 });

  return new NextResponse(await detailsSheet(), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="product-details.xlsx"',
      "cache-control": "no-store",
    },
  });
}

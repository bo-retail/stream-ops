import { NextResponse } from "next/server";
import { canSeeCost, getCurrentUser } from "@/lib/auth/guards";
import { masterGapsSheet } from "@/lib/server/inventory";

/** Models missing what the Invicta master should give them — admins only, like the master. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  if (!canSeeCost(user)) return new NextResponse("Not allowed.", { status: 403 });

  return new NextResponse(await masterGapsSheet(), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="missing-from-the-master.xlsx"',
      "cache-control": "no-store",
    },
  });
}

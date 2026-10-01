import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { picturesFor } from "@/lib/server/inventory";

/** Enough for any real box; anything longer is not a box. */
const MOST = 100;

/**
 * The pictures of the watches in a box, for the packing screen.
 *
 * A plain request rather than a server action on purpose: a page runs its
 * server actions one at a time, so a picture lookup made that way could hold
 * up the next scan. This one runs beside them, and if it is slow or fails the
 * screen simply shows no pictures. Pictures only — no stock or cost.
 *
 *   GET /api/shipping/pictures?s=49888&s=TM-525003
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  if (user.role !== "BOSS" && user.team !== "SHIPPING") return new NextResponse("Not allowed.", { status: 403 });

  const wanted = new URL(req.url).searchParams.getAll("s").slice(0, MOST);
  const pictures = await picturesFor(wanted);
  return NextResponse.json(Object.fromEntries(pictures), { headers: { "cache-control": "no-store" } });
}

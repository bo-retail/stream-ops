import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { templateSheet } from "@/lib/server/movements";
import type { Kind } from "@/lib/server/movements";

const FILES: Record<string, { kind: Kind; name: string }> = {
  moves: { kind: "MOVES", name: "moves-between-places-template.xlsx" },
  adjustments: { kind: "ADJUSTMENTS", name: "adjustments-template.xlsx" },
  returns: { kind: "RETURNS", name: "returns-and-cancellations-template.xlsx" },
};

/** A blank movements template, always the current one. */
export async function GET(_req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  const allowed = user.role === "BOSS" || (user.role === "MANAGER" && user.team === "SHIPPING");
  if (!allowed) return new NextResponse("Not allowed.", { status: 403 });
  const f = FILES[(await params).kind];
  if (!f) return new NextResponse("No such template.", { status: 404 });
  return new NextResponse(await templateSheet(f.kind), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${f.name}"`,
      "cache-control": "no-store",
    },
  });
}

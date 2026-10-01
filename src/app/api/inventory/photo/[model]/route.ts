import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { readPhoto } from "@/lib/server/inventory";

/**
 * A model's uploaded photo.
 *
 * The address carries the time it was saved (`?v=`), so a new photo is a new
 * address and the browser can keep each one for good. Private, because only
 * the shipping team (directors, and packers on the packing screen) and the
 * admins see these.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ model: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in.", { status: 401 });
  if (user.role !== "BOSS" && user.team !== "SHIPPING") return new NextResponse("Not allowed.", { status: 403 });

  const { model } = await params;
  // Next has already decoded it; decoding again would break a model with a "%".
  const photo = await readPhoto(model);
  if (!photo) return new NextResponse("No photo.", { status: 404 });
  return new NextResponse(Buffer.from(photo.data), {
    headers: {
      "content-type": photo.contentType,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

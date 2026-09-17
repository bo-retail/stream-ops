import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import type { Business } from "@/lib/domain/business";

/**
 * Which business a release — and so everything hanging off it — belongs to.
 *
 * Shows and availability carry the business themselves, copied from here when
 * they are created. That is a denormalisation, and this is the one place it is
 * read from, so every copy comes from the same source rather than from whatever
 * the caller happened to have to hand.
 *
 * Cached per request: answering a release means writing a fortnight of
 * availability rows in one transaction, and the question would otherwise be
 * asked once per row.
 */
export const businessOfRelease = cache(async (releaseId: string): Promise<Business> => {
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { business: true },
  });
  // A release that has gone is a caller's problem, not a business question, and
  // every guard above this has already refused that case. Watches are the
  // answer that keeps an orphan out of the other side's figures.
  return release?.business ?? "WATCH";
});

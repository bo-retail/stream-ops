import { Badge } from "@/components/ui";
import { BUSINESS_SHORT } from "@/lib/domain/business";
import type { Business } from "@/lib/domain/business";
import { PLATFORM_SHORT, SLOT_SHORT } from "@/lib/domain/types";
import type { Platform, Slot } from "@/lib/domain/types";

export function PlatformBadge({ platform }: { platform: Platform }) {
  return <Badge tone={platform === "TIKTOK" ? "tiktok" : "ebay"}>{PLATFORM_SHORT[platform]}</Badge>;
}

/**
 * Which kind of show, wherever both can appear side by side.
 *
 * Both are badged, not just diamonds. Marking only the exception is fewer
 * labels, but it asks the reader to know that a bare row means watches — and
 * somebody who has not been told reads it as a row that forgot to say. Saying
 * it on every row costs one quiet badge and leaves nothing to infer.
 *
 * It comes first, before the platform, because it is the bigger division: a
 * diamond TikTok Day and a watch TikTok Day are different shows, run by
 * different people, selling through different shops.
 */
export function BusinessBadge({ business }: { business: Business }) {
  return (
    <Badge tone={business === "DIAMOND" ? "diamond" : "watch"}>{BUSINESS_SHORT[business]}</Badge>
  );
}

export function SlotBadge({ slot }: { slot: Slot }) {
  return <Badge tone={slot === "DAY" ? "warn" : "brand"}>{SLOT_SHORT[slot]}</Badge>;
}

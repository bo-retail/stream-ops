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
 * Deliberately shown only for diamonds. Watches are the great majority of every
 * list, and badging all of them would be nineteen identical labels to carry the
 * information that four rows are different — so the exception is what is marked,
 * and an unbadged row reads as the watch show it always was.
 */
export function BusinessBadge({ business }: { business: Business }) {
  if (business === "WATCH") return null;
  return <Badge tone="brand">{BUSINESS_SHORT[business]}</Badge>;
}

export function SlotBadge({ slot }: { slot: Slot }) {
  return <Badge tone={slot === "DAY" ? "warn" : "brand"}>{SLOT_SHORT[slot]}</Badge>;
}

import { Badge } from "@/components/ui";
import { PLATFORM_SHORT, SLOT_SHORT } from "@/lib/domain/types";
import type { Platform, Slot } from "@/lib/domain/types";

export function PlatformBadge({ platform }: { platform: Platform }) {
  return <Badge tone={platform === "TIKTOK" ? "tiktok" : "ebay"}>{PLATFORM_SHORT[platform]}</Badge>;
}

export function SlotBadge({ slot }: { slot: Slot }) {
  return <Badge tone={slot === "DAY" ? "warn" : "brand"}>{SLOT_SHORT[slot]}</Badge>;
}

/**
 * Domain vocabulary, deliberately independent of Prisma's generated types.
 *
 * Everything under `src/lib/domain` is pure: no database, no framework, no I/O.
 * That is what makes the scheduling rules testable in isolation.
 */

export type Platform = "TIKTOK" | "EBAY";
/**
 * Which of the day's shows.
 *
 * "DAY" and "NIGHT" are the two every release has always had. A release may
 * also carry shows of its own — an early morning TikTok from 7 to 1, say — and
 * those are known by the name the boss gave them, kept in capitals
 * ("EARLY AM"). See `normaliseSlotName`.
 */
export type Slot = string;
export type ShowStatus = "SCHEDULED" | "CANCELLED";

/**
 * Every show is run by two people.
 *
 * The pair are interchangeable — they split the show between camera and
 * computer and swap halfway — so a seat is just a slot to put a name in, and
 * seat 1 means nothing more than seat 2.
 */
export const SEATS_PER_SHOW = 2;
export const SEATS: readonly number[] = [1, 2] as const;

export const PLATFORMS: readonly Platform[] = ["TIKTOK", "EBAY"] as const;
/** The two shows every release has always had. */
export const STANDARD_SLOTS: readonly Slot[] = ["DAY", "NIGHT"] as const;

export const PLATFORM_LABEL: Record<Platform, string> = {
  TIKTOK: "TikTok Shop",
  EBAY: "eBay Live",
};

export const PLATFORM_SHORT: Record<Platform, string> = {
  TIKTOK: "TikTok",
  EBAY: "eBay",
};

/** "Day", "Night", or the name the boss gave an extra show. */
export function slotShort(slot: Slot): string {
  if (slot === "DAY") return "Day";
  if (slot === "NIGHT") return "Night";
  return slot;
}

/**
 * Words an extra show may not be called.
 *
 * "Day" and "Night" are the standard shows already. "AM" and "PM" are what the
 * sales files call those two ("TikTok AM"), so a show named either would be
 * read back as the day or night show and paid as one.
 */
const RESERVED_SLOT_NAMES = new Set(["DAY", "NIGHT", "AM", "PM", "DAY SHOW", "NIGHT SHOW"]);

/**
 * The slot an extra show's name is kept under, or what is wrong with it.
 *
 * Capitals and single spaces, letters and digits — the name ends up in sales
 * records ("TikTok EARLY AM") and on every screen, so it is kept to something
 * that cannot be mistaken for another show.
 */
export function normaliseSlotName(name: string): { slot: Slot } | { error: string } {
  const slot = name.trim().replace(/\s+/g, " ").toUpperCase();
  if (slot === "") return { error: 'Give the show a name, like "Early AM".' };
  if (slot.length > 20) return { error: "Keep the show's name to 20 characters or fewer." };
  if (!/^[A-Z0-9][A-Z0-9 ]*$/.test(slot)) {
    return { error: "A show's name can have letters, numbers and spaces only." };
  }
  if (RESERVED_SLOT_NAMES.has(slot)) {
    return { error: `"${name.trim()}" is already a standard show — pick another name, like "Early AM".` };
  }
  return { slot };
}

/** The day or night show, which every platform has. */
export function isStandardSlot(slot: Slot): boolean {
  return slot === "DAY" || slot === "NIGHT";
}

/**
 * Whether a platform can run a show in this slot. An extra show is TikTok only:
 * an eBay export marks each item AM or PM and nothing else, so a third eBay
 * show could never be credited with what it sold, and its pair would be paid
 * nothing for it.
 */
export function platformRunsSlot(platform: Platform, slot: Slot): boolean {
  return platform === "TIKTOK" || isStandardSlot(slot);
}

/** Whether a value is a slot: a standard show, or a well-formed extra one. */
export function isSlot(value: string): boolean {
  if (value === "DAY" || value === "NIGHT") return true;
  const n = normaliseSlotName(value);
  return "slot" in n && n.slot === value;
}

/**
 * Shows in a fixed order where their hours are not to hand: day, night, then
 * extras by name. Where hours are known, sorting by start time is used instead.
 */
export function compareSlots(a: Slot, b: Slot): number {
  const rank = (s: Slot) => (s === "DAY" ? 0 : s === "NIGHT" ? 1 : 2);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * The slots a set of shows uses, in the order they run in a day.
 *
 * Day and night are always there — screens that have always had those two
 * columns keep them — and an extra show sits where its hours put it: an early
 * morning show before the day show, a late one after the night. Ordered by the
 * earliest start each slot has, so "07:00" comes before "13:00".
 */
export function slotsInOrder(shows: readonly { slot: Slot; startHM?: TimeHM }[]): Slot[] {
  const earliest = new Map<Slot, string>([
    ["DAY", SUGGESTED_HOURS.DAY.start],
    ["NIGHT", SUGGESTED_HOURS.NIGHT.start],
  ]);
  for (const s of shows) {
    if (!earliest.has(s.slot)) earliest.set(s.slot, s.startHM ?? "99:99");
    else if (s.slot !== "DAY" && s.slot !== "NIGHT" && s.startHM && s.startHM < earliest.get(s.slot)!) {
      earliest.set(s.slot, s.startHM);
    }
  }
  return [...earliest.keys()].sort(
    (a, b) => earliest.get(a)!.localeCompare(earliest.get(b)!) || compareSlots(a, b),
  );
}

/** A calendar date in the business time zone, formatted `YYYY-MM-DD`. */
export type DateISO = string;

/** A wall-clock time in the business time zone, formatted `HH:mm`. */
export type TimeHM = string;

/**
 * What is genuinely the same every time.
 *
 * Show hours and the scheduling rules used to live here as standing defaults.
 * They moved onto each release: this business has no default fortnight, and a
 * default that is wrong most weeks is worse than no default at all.
 */
export interface BusinessSettings {
  timezone: string;
  /**
   * A watch streamer's hour, in whole cents. Only the fallback now: what is paid
   * is read per kind of show from BusinessSettings, and kept equal to this.
   */
  streamerHourlyCents: number;
  /** What somebody on shipping is paid an hour, in whole cents. */
  shippingHourlyCents: number;
  /** A streamer's share of their show's sales, in basis points: 100 = 1.00%. */
  streamerCommissionBps: number;
}

export const DEFAULT_SETTINGS: BusinessSettings = {
  timezone: "America/New_York",
  streamerHourlyCents: 0,
  shippingHourlyCents: 0,
  streamerCommissionBps: 100,
};

/**
 * Starting values for the hour boxes when composing a release.
 *
 * A convenience for the form and nothing more — never stored, never applied to
 * anything already created, and overwritten the moment the boss types over it.
 */
export const SUGGESTED_HOURS: Record<"DAY" | "NIGHT", { start: TimeHM; end: TimeHM }> = {
  DAY: { start: "13:00", end: "19:00" },
  NIGHT: { start: "19:00", end: "01:00" },
};

/**
 * Domain vocabulary, deliberately independent of Prisma's generated types.
 *
 * Everything under `src/lib/domain` is pure: no database, no framework, no I/O.
 * That is what makes the scheduling rules testable in isolation.
 */

export type Platform = "TIKTOK" | "EBAY";
/** Which of the day's two shows. */
export type Slot = "DAY" | "NIGHT";
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
export const SLOTS: readonly Slot[] = ["DAY", "NIGHT"] as const;

/** Every show that exists on a given day: both platforms, both slots. */
export const DAILY_SHOWS: readonly { platform: Platform; slot: Slot }[] = PLATFORMS.flatMap(
  (platform) => SLOTS.map((slot) => ({ platform, slot })),
);

export const PLATFORM_LABEL: Record<Platform, string> = {
  TIKTOK: "TikTok Shop",
  EBAY: "eBay Live",
};

export const PLATFORM_SHORT: Record<Platform, string> = {
  TIKTOK: "TikTok",
  EBAY: "eBay",
};

export const SLOT_LABEL: Record<Slot, string> = {
  DAY: "Day show",
  NIGHT: "Night show",
};

export const SLOT_SHORT: Record<Slot, string> = {
  DAY: "Day",
  NIGHT: "Night",
};

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
  /** What a streamer is paid an hour, in whole cents. */
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
export const SUGGESTED_HOURS: Record<Slot, { start: TimeHM; end: TimeHM }> = {
  DAY: { start: "13:00", end: "19:00" },
  NIGHT: { start: "19:00", end: "01:00" },
};

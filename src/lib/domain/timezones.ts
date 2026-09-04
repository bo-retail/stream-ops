/**
 * Time zones the business can operate in.
 *
 * Kept as an explicit list rather than accepting any IANA string: an
 * unrecognised zone would silently shift every show time and pay period.
 *
 * This lives in its own module because a `"use server"` file may only export
 * async functions — a constant exported from one becomes an action reference.
 */
export const SUPPORTED_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
] as const;

export type SupportedTimezone = (typeof SUPPORTED_TIMEZONES)[number];

export function isSupportedTimezone(value: string): value is SupportedTimezone {
  return (SUPPORTED_TIMEZONES as readonly string[]).includes(value);
}

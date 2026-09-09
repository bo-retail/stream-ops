/**
 * What somebody is owed.
 *
 * Pure, and deliberately so: this is the arithmetic that turns into money
 * leaving the business, and every one of its edge cases — a rounding, a rate
 * that has not been set, a show whose sales landed under a different day's tag —
 * produces a plausible-looking number rather than an error. The only way to know
 * it is right is to be able to state each rule and test it on its own.
 *
 * Two things are paid:
 *
 *   Hours       Everyone. Minutes come from the timesheet, which is already the
 *               authority on what counts: a streamer's hours are printed from
 *               the published schedule, shipping clock in and out.
 *
 *   Commission  Streamers only, on the sales of the shows they were on. Both
 *               people on a show earn it separately, so a show at 1% pays out
 *               2% of its sales in total. That is intended — it is 1% each, not
 *               1% split.
 */

import type { DateISO, Platform, Slot } from "./types";

/** The business-wide rates. Whole cents, and basis points for the percentage. */
export interface Rates {
  streamerHourlyCents: number;
  shippingHourlyCents: number;
  /** 100 = 1.00%. */
  streamerCommissionBps: number;
}

/** What one person is paid, where it differs from their team's rate. */
export interface PersonRateOverride {
  hourlyRateCents: number | null;
  commissionBps: number | null;
}

export type Team = "STREAMING" | "SHIPPING";

/**
 * The hourly rate that applies to one person.
 *
 * Their own if they have one — including a deliberate zero, which is why this
 * tests for null rather than for falsiness. Somebody set to £0/hour on purpose
 * must not silently fall back to the team rate.
 */
export function hourlyRateFor(
  team: Team,
  override: PersonRateOverride | null | undefined,
  rates: Rates,
): number {
  if (override && override.hourlyRateCents !== null) return override.hourlyRateCents;
  return team === "SHIPPING" ? rates.shippingHourlyCents : rates.streamerHourlyCents;
}

/** The same, for commission. Shipping earn none, whatever is set against them. */
export function commissionBpsFor(
  team: Team,
  override: PersonRateOverride | null | undefined,
  rates: Rates,
): number {
  if (team === "SHIPPING") return 0;
  if (override && override.commissionBps !== null) return override.commissionBps;
  return rates.streamerCommissionBps;
}

/**
 * Hours at a rate, to the nearest cent.
 *
 * Multiplied before it is divided, so a half-hour at $17.35 is 867.5 cents
 * rounded once to 868 rather than accumulated from a rounded hourly figure.
 * Minutes are already integers, so nothing upstream has rounded yet.
 */
export function hourlyPayCents(minutes: number, rateCents: number): number {
  if (minutes <= 0 || rateCents <= 0) return 0;
  return Math.round((minutes * rateCents) / 60);
}

/** A share of a show's sales, to the nearest cent. */
export function commissionCents(netRevenueCents: number, bps: number): number {
  if (netRevenueCents <= 0 || bps <= 0) return 0;
  return Math.round((netRevenueCents * bps) / 10_000);
}

/* ------------------------------------------------ which show earned the sale */

/** A show, as a key that a sale and a rota row can both be reduced to. */
export interface ShowKey {
  dateISO: DateISO;
  platform: Platform;
  slot: Slot;
}

export function showKey(k: ShowKey): string {
  return `${k.dateISO}|${k.platform}|${k.slot}`;
}

/**
 * Which show's team is paid for a sale: the one it sold in.
 *
 * Whoever was live when the buyer paid earned it. A watch listed for the
 * morning show that somebody buys during the evening one was sold by the
 * evening pair, and it is theirs.
 *
 * There is deliberately no function here to work that out, because the
 * ingestion has already done it and put the answer in `SalesRecord.show` — from
 * the order's timestamp on TikTok, and from the Custom Label on eBay, which
 * records no time of day at all and so has nothing else to go on (R15). Working
 * it out a second time here is how the payroll screen and the sales screen come
 * to disagree about the same show. See `lib/server/payroll`.
 *
 * The shift tag is not consulted for pay. It answers a different question —
 * which show a listing was *prepared* for — and it is what the workbook's
 * per-shift breakdown is built on.
 */

/* --------------------------------------------------------------- formatting */

/** Basis points as a percentage: 100 → "1%", 125 → "1.25%", 0 → "0%". */
export function formatBps(bps: number): string {
  const percent = bps / 100;
  return `${Number(percent.toFixed(2))}%`;
}

/**
 * A typed percentage back into basis points. `"1"` → 100, `"1.25"` → 125.
 *
 * Returns null rather than 0 for anything unreadable, so a typo in the rates
 * form is refused instead of silently setting the commission to nothing.
 */
export function parsePercentToBps(input: string): number | null {
  const cleaned = input.trim().replace(/%$/, "").trim();
  if (cleaned === "") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  // Two decimal places is the resolution of a basis point; more is a typo.
  return Math.round(value * 100);
}

/** `"17.50"` → 1750. Null for anything that is not money. */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/* ------------------------------------------------------------- one person */

export interface ShowEarning {
  key: ShowKey;
  label: string;
  netRevenueCents: number;
  bps: number;
  commissionCents: number;
}

export interface PersonPay {
  userId: string;
  name: string;
  team: Team;
  position: string;

  minutes: number;
  hourlyRateCents: number;
  hourlyPayCents: number;

  commissionBps: number;
  shows: ShowEarning[];
  commissionCents: number;

  totalCents: number;
  /** Hours recorded but never clocked out, so not paid. */
  openShifts: number;
  /** True when nobody has given this person a rate yet. */
  unrated: boolean;
}

/**
 * One person's pay for a period.
 *
 * Deliberately takes everything it needs rather than reading anything: the
 * caller has already decided which minutes count and which shows this person
 * was on, and both of those are questions with their own rules.
 */
export function payFor(input: {
  userId: string;
  name: string;
  team: Team;
  position: string;
  minutes: number;
  openShifts: number;
  override: PersonRateOverride | null;
  rates: Rates;
  /** The shows this person was on, with what those shows sold. */
  shows: { key: ShowKey; label: string; netRevenueCents: number }[];
}): PersonPay {
  const rate = hourlyRateFor(input.team, input.override, input.rates);
  const bps = commissionBpsFor(input.team, input.override, input.rates);

  const hourly = hourlyPayCents(input.minutes, rate);

  const shows: ShowEarning[] = input.shows.map((s) => ({
    key: s.key,
    label: s.label,
    netRevenueCents: s.netRevenueCents,
    bps,
    commissionCents: commissionCents(s.netRevenueCents, bps),
  }));
  const commission = shows.reduce((n, s) => n + s.commissionCents, 0);

  return {
    userId: input.userId,
    name: input.name,
    team: input.team,
    position: input.position,
    minutes: input.minutes,
    hourlyRateCents: rate,
    hourlyPayCents: hourly,
    commissionBps: bps,
    shows,
    commissionCents: commission,
    totalCents: hourly + commission,
    openShifts: input.openShifts,
    // Somebody with hours but no rate is the failure this is here to make
    // visible: their pay comes out as zero, which looks like a real answer.
    unrated: rate === 0 && input.minutes > 0,
  };
}

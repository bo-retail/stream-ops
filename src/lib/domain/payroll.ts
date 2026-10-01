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
 *               the published schedule, shipping clock in and out. A streamer's
 *               hours on a diamond show are paid at the diamond rate, every
 *               other streamer hour at the watch rate.
 *
 *   Commission  Streamers only, on the sales of the shows they were on. Both
 *               people on a show earn it separately, so a show at 1% pays out
 *               2% of its sales in total. That is intended — it is 1% each, not
 *               1% split.
 */

import type { Business } from "./business";
import type { DateISO, Platform, Slot } from "./types";

/** The business-wide rates. Whole cents, and basis points for the percentage. */
export interface Rates {
  /**
   * A watch streamer's hour — and any streamer hour that is not on a diamond
   * show, such as off-schedule work clocked with no show attached.
   */
  streamerHourlyCents: number;
  /** A streamer's hour on a diamond show. */
  diamondStreamerHourlyCents: number;
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
 * tests for null rather than for falsiness. Somebody set to $0/hour on purpose
 * must not silently fall back to the team rate.
 *
 * A person's own rate covers every hour they work, watch or diamond: it is set
 * on somebody because they are paid differently from everyone else, not
 * differently per show. Without one, a streamer is paid the rate of the kind
 * of show the hours were on. Shipping have one rate whatever they pack.
 */
export function hourlyRateFor(
  team: Team,
  override: PersonRateOverride | null | undefined,
  rates: Rates,
  business: Business = "WATCH",
): number {
  if (override && override.hourlyRateCents !== null) return override.hourlyRateCents;
  if (team === "SHIPPING") return rates.shippingHourlyCents;
  return business === "DIAMOND" ? rates.diamondStreamerHourlyCents : rates.streamerHourlyCents;
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
  /**
   * Watches or diamonds.
   *
   * Without it this key is a money bug, not a detail. Both sell on TikTok at
   * the same hours, so a watch TikTok Day and a diamond TikTok Day on one date
   * reduce to the same string — their sales pool into one bucket and whichever
   * rota row is read last overwrites who was on it. One pair then earns
   * commission on both shows' takings and the other earns nothing.
   */
  business: Business;
  dateISO: DateISO;
  platform: Platform;
  slot: Slot;
}

export function showKey(k: ShowKey): string {
  return `${k.business}|${k.dateISO}|${k.platform}|${k.slot}`;
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

/** Hours at one rate. A streamer on both kinds of show has two of these. */
export interface HourlyLine {
  business: Business;
  minutes: number;
  rateCents: number;
  payCents: number;
}

export interface PersonPay {
  userId: string;
  name: string;
  team: Team;
  position: string;

  minutes: number;
  /**
   * The one rate to print beside the person. When their hours were paid at two
   * different rates there is no honest single figure: this is then the watch
   * rate, and `hourly` is where the real breakdown is.
   */
  hourlyRateCents: number;
  /** Their hours split by the rate each was paid at. Empty when they worked none. */
  hourly: HourlyLine[];
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
  /** Every paid minute, watch and diamond together. */
  minutes: number;
  /**
   * How many of those minutes were on a diamond show. The rest are paid at the
   * watch rate. Ignored for shipping, who have one rate.
   */
  diamondMinutes: number;
  openShifts: number;
  override: PersonRateOverride | null;
  rates: Rates;
  /**
   * The shows this person was on, what those shows sold, and the rate that
   * show's kind of business pays.
   *
   * The rate arrives per show rather than per person because watches and
   * diamonds can be set apart — a diamond piece averaged $257 against roughly
   * $100 for a watch, so the same percentage is a very different amount. One
   * person can be on both in a fortnight.
   */
  shows: { key: ShowKey; label: string; netRevenueCents: number; bps: number }[];
}): PersonPay {
  /*
    Hours, split by the rate they are paid at.

    The total is rounded once, from the exact sum, so somebody whose two rates
    happen to be equal is paid to the cent what one rate would have paid them —
    rounding each part separately can add a cent that nobody earned. Each line
    is rounded for the breakdown and the last one takes the leftover cent, so
    the lines still add up to the total.

    Diamond minutes are capped at the total: more diamond hours than hours is a
    caller's mistake, and must not turn into negative watch hours paid as a
    deduction.
  */
  const diamond =
    input.team === "SHIPPING" ? 0 : Math.min(Math.max(input.diamondMinutes, 0), input.minutes);
  const parts: { business: Business; minutes: number }[] = [
    { business: "WATCH", minutes: input.minutes - diamond },
    { business: "DIAMOND", minutes: diamond },
  ];
  const lines: HourlyLine[] = parts
    .filter((p) => p.minutes > 0)
    .map((p) => {
      const rateCents = hourlyRateFor(input.team, input.override, input.rates, p.business);
      return { ...p, rateCents, payCents: hourlyPayCents(p.minutes, rateCents) };
    });
  const exact = lines.reduce((n, l) => n + l.minutes * Math.max(l.rateCents, 0), 0);
  const hourly = Math.round(exact / 60);
  if (lines.length > 0) {
    lines[lines.length - 1].payCents += hourly - lines.reduce((n, l) => n + l.payCents, 0);
  }
  // Only diamond hours: their rate is the one that applied. Otherwise the watch
  // rate, which is also what anyone with no hours at all is shown.
  const rate =
    lines.length === 1 ? lines[0].rateCents : hourlyRateFor(input.team, input.override, input.rates);

  const shows: ShowEarning[] = input.shows.map((s) => {
    // A rate set on the person beats the business's, exactly as it did before.
    const bps = input.override?.commissionBps ?? s.bps;
    return {
      key: s.key,
      label: s.label,
      netRevenueCents: s.netRevenueCents,
      bps,
      commissionCents: commissionCents(s.netRevenueCents, bps),
    };
  });
  const commission = shows.reduce((n, s) => n + s.commissionCents, 0);

  /*
    The single rate to print beside the person's total.

    True whenever every show they were on pays the same, which is the normal
    case and is true of both businesses today. When they differ there is no
    honest single number, so the fallback is their team's default and the
    per-show breakdown above is where the real rates are.
  */
  const rates = new Set(shows.map((s) => s.bps));
  const bps =
    rates.size === 1
      ? [...rates][0]
      : commissionBpsFor(input.team, input.override, input.rates);

  return {
    userId: input.userId,
    name: input.name,
    team: input.team,
    position: input.position,
    minutes: input.minutes,
    hourlyRateCents: rate,
    hourly: lines,
    hourlyPayCents: hourly,
    commissionBps: bps,
    shows,
    commissionCents: commission,
    totalCents: hourly + commission,
    openShifts: input.openShifts,
    // Somebody with hours but no rate is the failure this is here to make
    // visible: their pay comes out as zero, which looks like a real answer.
    // Checked per line, so diamond hours with no diamond rate are caught even
    // when the same person's watch hours were paid.
    unrated: lines.some((l) => l.rateCents === 0),
  };
}

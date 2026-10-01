import { describe, expect, it } from "vitest";
import {
  commissionBpsFor,
  commissionCents,
  formatBps,
  hourlyPayCents,
  hourlyRateFor,
  parseMoneyToCents,
  parsePercentToBps,
  payFor,
  showKey,
} from "./payroll";
import type { Rates } from "./payroll";

const RATES: Rates = {
  streamerHourlyCents: 1800,
  diamondStreamerHourlyCents: 2200,
  shippingHourlyCents: 1600,
  streamerCommissionBps: 100,
};

describe("which rate applies", () => {
  it("uses the team's rate when the person has none of their own", () => {
    expect(hourlyRateFor("STREAMING", null, RATES)).toBe(1800);
    expect(hourlyRateFor("SHIPPING", null, RATES)).toBe(1600);
  });

  it("prefers the person's own rate", () => {
    const own = { hourlyRateCents: 2500, commissionBps: null };
    expect(hourlyRateFor("STREAMING", own, RATES)).toBe(2500);
  });

  // Somebody deliberately set to nothing must not quietly fall back to the team
  // rate. Zero is an answer; absent is the question.
  it("treats a deliberate zero as a rate, not as absent", () => {
    const unpaid = { hourlyRateCents: 0, commissionBps: null };
    expect(hourlyRateFor("STREAMING", unpaid, RATES)).toBe(0);
  });

  it("gives shipping no commission, whatever is set against them", () => {
    expect(commissionBpsFor("SHIPPING", null, RATES)).toBe(0);
    expect(commissionBpsFor("SHIPPING", { hourlyRateCents: null, commissionBps: 500 }, RATES)).toBe(0);
  });

  it("gives a streamer the standard commission, or their own", () => {
    expect(commissionBpsFor("STREAMING", null, RATES)).toBe(100);
    expect(commissionBpsFor("STREAMING", { hourlyRateCents: null, commissionBps: 250 }, RATES)).toBe(250);
    expect(commissionBpsFor("STREAMING", { hourlyRateCents: null, commissionBps: 0 }, RATES)).toBe(0);
  });
});

describe("hours at a rate", () => {
  it("pays a whole hour", () => {
    expect(hourlyPayCents(60, 1800)).toBe(1800);
  });

  it("pays part of one", () => {
    expect(hourlyPayCents(90, 1800)).toBe(2700);
    expect(hourlyPayCents(30, 1800)).toBe(900);
  });

  // Multiplied before divided, so the half-cent is rounded once at the end
  // rather than accumulated from a rounded hourly figure.
  it("rounds once, at the end", () => {
    expect(hourlyPayCents(30, 1735)).toBe(868); // 867.5
    expect(hourlyPayCents(1, 1800)).toBe(30);
    expect(hourlyPayCents(7, 1735)).toBe(202); // 202.4166…
  });

  it("pays nothing for no hours, and nothing at no rate", () => {
    expect(hourlyPayCents(0, 1800)).toBe(0);
    expect(hourlyPayCents(600, 0)).toBe(0);
    expect(hourlyPayCents(-30, 1800)).toBe(0);
  });
});

describe("commission on a show", () => {
  it("is one per cent of the sales", () => {
    expect(commissionCents(1_853_820, 100)).toBe(18_538);
  });

  it("moves with the rate", () => {
    expect(commissionCents(1_000_000, 250)).toBe(25_000);
    expect(commissionCents(1_000_000, 0)).toBe(0);
  });

  it("rounds to the cent", () => {
    expect(commissionCents(12_345, 100)).toBe(123); // 123.45
    expect(commissionCents(12_355, 100)).toBe(124); // 123.55
  });

  it("pays nothing on a show that sold nothing", () => {
    expect(commissionCents(0, 100)).toBe(0);
  });
});

describe("keying a show", () => {
  // A sale and a rota row have to reduce to the same string or the join is a
  // guess. Which show a sale belongs to is settled by the ingestion, not here —
  // see the note in payroll.ts.
  it("keys a show the same way from either side", () => {
    expect(
      showKey({ business: "WATCH", dateISO: "2026-09-08", platform: "TIKTOK", slot: "NIGHT" }),
    ).toBe("WATCH|2026-09-08|TIKTOK|NIGHT");
    expect(
      showKey({ business: "WATCH", dateISO: "2026-09-08", platform: "EBAY", slot: "DAY" }),
    ).toBe("WATCH|2026-09-08|EBAY|DAY");
  });

  it("keeps two shows apart when only the business differs", () => {
    /*
      The bug this is here to stop.

      Watches and diamonds both sell on TikTok at the same hours, so a watch
      TikTok Day and a diamond TikTok Day on one date are identical in every
      other field. Keyed without the business they pool into one bucket: their
      takings are added together, whichever rota row is read last overwrites who
      was on it, and one pair earns commission on both shows while the other
      earns nothing at all.
    */
    const watch = showKey({
      business: "WATCH",
      dateISO: "2026-09-18",
      platform: "TIKTOK",
      slot: "DAY",
    });
    const diamond = showKey({
      business: "DIAMOND",
      dateISO: "2026-09-18",
      platform: "TIKTOK",
      slot: "DAY",
    });
    expect(watch).not.toBe(diamond);
  });
});

describe("reading a rate somebody typed", () => {
  it("takes a percentage", () => {
    expect(parsePercentToBps("1")).toBe(100);
    expect(parsePercentToBps("1.25")).toBe(125);
    expect(parsePercentToBps("1%")).toBe(100);
    expect(parsePercentToBps(" 0.5 ")).toBe(50);
    expect(parsePercentToBps("0")).toBe(0);
  });

  // Null, not zero: a typo in the rates form must be refused rather than
  // silently setting the commission to nothing.
  it("refuses anything that is not one", () => {
    expect(parsePercentToBps("")).toBeNull();
    expect(parsePercentToBps("abc")).toBeNull();
    expect(parsePercentToBps("-1")).toBeNull();
  });

  it("takes money", () => {
    expect(parseMoneyToCents("17.50")).toBe(1750);
    expect(parseMoneyToCents("$1,750.00")).toBe(175_000);
    expect(parseMoneyToCents("18")).toBe(1800);
    expect(parseMoneyToCents("0")).toBe(0);
  });

  it("refuses money that is not money", () => {
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents("free")).toBeNull();
    expect(parseMoneyToCents("-5")).toBeNull();
  });

  it("writes a rate back the way it was typed", () => {
    expect(formatBps(100)).toBe("1%");
    expect(formatBps(125)).toBe("1.25%");
    expect(formatBps(0)).toBe("0%");
    expect(formatBps(50)).toBe("0.5%");
  });
});

describe("one person's pay", () => {
  const show = (label: string, cents: number, bps = RATES.streamerCommissionBps) => ({
    key: {
      business: "WATCH" as const,
      dateISO: "2026-09-08" as const,
      platform: "TIKTOK" as const,
      slot: "NIGHT" as const,
    },
    label,
    netRevenueCents: cents,
    bps,
  });

  it("adds commission on top of the hours", () => {
    const pay = payFor({
      userId: "u1",
      name: "Maya",
      team: "STREAMING",
      position: "Streamer",
      minutes: 360,
      diamondMinutes: 0,
      openShifts: 0,
      override: null,
      rates: RATES,
      shows: [show("TikTok PM", 736_900)],
    });

    expect(pay.hourlyPayCents).toBe(10_800); // 6h at $18
    expect(pay.commissionCents).toBe(7369); // 1% of $7,369
    expect(pay.totalCents).toBe(18_169);
  });

  it("pays shipping their hours and nothing else", () => {
    const pay = payFor({
      userId: "u2",
      name: "Pat",
      team: "SHIPPING",
      position: "Shipping & packer",
      minutes: 480,
      diamondMinutes: 0,
      openShifts: 0,
      override: null,
      rates: RATES,
      shows: [],
    });

    expect(pay.hourlyPayCents).toBe(12_800); // 8h at $16
    expect(pay.commissionCents).toBe(0);
    expect(pay.totalCents).toBe(12_800);
  });

  // Both people on a show earn it separately. A show at 1% pays out 2% of its
  // sales in total, which is intended: it is 1% each, not 1% split.
  it("pays each person on a show the full rate", () => {
    const both = ["Maya", "Devon"].map((name) =>
      payFor({
        userId: name,
        name,
        team: "STREAMING",
        position: "Streamer",
        minutes: 0,
        diamondMinutes: 0,
        openShifts: 0,
        override: null,
        rates: RATES,
        shows: [show("TikTok PM", 1_000_000)],
      }),
    );

    expect(both.map((p) => p.commissionCents)).toEqual([10_000, 10_000]);
  });

  it("adds up several shows", () => {
    const pay = payFor({
      userId: "u1",
      name: "Maya",
      team: "STREAMING",
      position: "Streamer",
      minutes: 0,
      diamondMinutes: 0,
      openShifts: 0,
      override: null,
      rates: RATES,
      shows: [show("TikTok AM", 594_520), show("TikTok PM", 736_900)],
    });

    expect(pay.commissionCents).toBe(5945 + 7369);
    expect(pay.shows).toHaveLength(2);
  });

  it("uses the person's own commission when they have one", () => {
    const pay = payFor({
      userId: "u1",
      name: "Maya",
      team: "STREAMING",
      position: "Streamer",
      minutes: 0,
      diamondMinutes: 0,
      openShifts: 0,
      override: { hourlyRateCents: null, commissionBps: 200 },
      rates: RATES,
      shows: [show("TikTok PM", 1_000_000)],
    });

    expect(pay.commissionCents).toBe(20_000);
  });

  // Hours with no rate come out as zero, which reads exactly like a real
  // answer. This is what puts it on screen instead.
  it("flags somebody who worked but has no rate", () => {
    const pay = payFor({
      userId: "u1",
      name: "Maya",
      team: "STREAMING",
      position: "Streamer",
      minutes: 360,
      diamondMinutes: 0,
      openShifts: 0,
      override: null,
      rates: { ...RATES, streamerHourlyCents: 0 },
      shows: [],
    });

    expect(pay.totalCents).toBe(0);
    expect(pay.unrated).toBe(true);
  });

  it("does not flag somebody who simply did not work", () => {
    const pay = payFor({
      userId: "u1",
      name: "Maya",
      team: "STREAMING",
      position: "Streamer",
      minutes: 0,
      diamondMinutes: 0,
      openShifts: 0,
      override: null,
      rates: { ...RATES, streamerHourlyCents: 0 },
      shows: [],
    });

    expect(pay.unrated).toBe(false);
  });
});

describe("watch streamers and diamond streamers are paid their own hourly", () => {
  const person = (over: Partial<Parameters<typeof payFor>[0]>) =>
    payFor({
      userId: "u1",
      name: "Maya",
      team: "STREAMING",
      position: "Streamer",
      minutes: 0,
      diamondMinutes: 0,
      openShifts: 0,
      override: null,
      rates: RATES,
      shows: [],
      ...over,
    });

  it("picks the rate by the kind of show", () => {
    expect(hourlyRateFor("STREAMING", null, RATES, "WATCH")).toBe(1800);
    expect(hourlyRateFor("STREAMING", null, RATES, "DIAMOND")).toBe(2200);
    // Shipping are not split: one rate whatever they pack.
    expect(hourlyRateFor("SHIPPING", null, RATES, "DIAMOND")).toBe(1600);
    // No business given means a watch hour, which is what it always was.
    expect(hourlyRateFor("STREAMING", null, RATES)).toBe(1800);
  });

  it("pays a diamond-only streamer the diamond rate", () => {
    const pay = person({ minutes: 240, diamondMinutes: 240 });
    expect(pay.hourlyPayCents).toBe(8800); // 4h at $22
    expect(pay.hourlyRateCents).toBe(2200);
    expect(pay.hourly).toEqual([{ business: "DIAMOND", minutes: 240, rateCents: 2200, payCents: 8800 }]);
  });

  it("splits a streamer who worked both by the hours on each", () => {
    // 6h on watches, 4h on diamonds.
    const pay = person({ minutes: 600, diamondMinutes: 240 });
    expect(pay.hourly).toEqual([
      { business: "WATCH", minutes: 360, rateCents: 1800, payCents: 10_800 },
      { business: "DIAMOND", minutes: 240, rateCents: 2200, payCents: 8800 },
    ]);
    expect(pay.hourlyPayCents).toBe(19_600);
    expect(pay.minutes).toBe(600);
  });

  it("rounds the total once, so equal rates pay what one rate always did", () => {
    // Half an hour of each at $18.01: 900.5c twice. Rounded apart that is
    // 901 + 901 = $18.02 for an hour paid $18.01 before the rates were split.
    const pay = person({
      minutes: 60,
      diamondMinutes: 30,
      rates: { ...RATES, streamerHourlyCents: 1801, diamondStreamerHourlyCents: 1801 },
    });
    expect(pay.hourlyPayCents).toBe(hourlyPayCents(60, 1801));
    expect(pay.hourlyPayCents).toBe(1801);
  });

  it("keeps the lines adding up to the total", () => {
    const pay = person({
      minutes: 60,
      diamondMinutes: 30,
      rates: { ...RATES, streamerHourlyCents: 1801, diamondStreamerHourlyCents: 1801 },
    });
    expect(pay.hourly.map((l) => l.payCents)).toEqual([901, 900]);
    expect(pay.hourly.reduce((n, l) => n + l.payCents, 0)).toBe(pay.hourlyPayCents);
  });

  it("rounds an uneven split once, to the nearest cent of the exact figure", () => {
    // 25 minutes at $17.35 = 722.92c, 35 minutes at $22.15 = 1292.08c; 2015c exactly.
    const pay = person({
      minutes: 60,
      diamondMinutes: 35,
      rates: { ...RATES, streamerHourlyCents: 1735, diamondStreamerHourlyCents: 2215 },
    });
    expect(pay.hourlyPayCents).toBe(2015);
    expect(pay.hourly.map((l) => l.payCents)).toEqual([723, 1292]);
  });

  it("lets a person's own rate beat both", () => {
    const pay = person({
      minutes: 600,
      diamondMinutes: 240,
      override: { hourlyRateCents: 2500, commissionBps: null },
    });
    expect(pay.hourly.map((l) => l.rateCents)).toEqual([2500, 2500]);
    expect(pay.hourlyPayCents).toBe(25_000);
  });

  it("keeps a deliberate $0 own rate at zero on diamond hours too", () => {
    const pay = person({
      minutes: 120,
      diamondMinutes: 120,
      override: { hourlyRateCents: 0, commissionBps: null },
    });
    expect(pay.hourlyPayCents).toBe(0);
  });

  it("pays shipping one rate even if minutes are marked diamond", () => {
    const pay = person({ team: "SHIPPING", minutes: 480, diamondMinutes: 480 });
    expect(pay.hourlyPayCents).toBe(12_800);
    expect(pay.hourly).toEqual([{ business: "WATCH", minutes: 480, rateCents: 1600, payCents: 12_800 }]);
  });

  it("never turns more diamond minutes than minutes into negative watch pay", () => {
    const pay = person({ minutes: 60, diamondMinutes: 90 });
    expect(pay.hourly).toEqual([{ business: "DIAMOND", minutes: 60, rateCents: 2200, payCents: 2200 }]);
  });

  it("flags diamond hours with no diamond rate set, even when watch hours were paid", () => {
    const pay = person({
      minutes: 600,
      diamondMinutes: 240,
      rates: { ...RATES, diamondStreamerHourlyCents: 0 },
    });
    expect(pay.hourlyPayCents).toBe(10_800);
    expect(pay.unrated).toBe(true);
  });

  it("does not flag a missing diamond rate for somebody who only did watches", () => {
    const pay = person({ minutes: 360, rates: { ...RATES, diamondStreamerHourlyCents: 0 } });
    expect(pay.unrated).toBe(false);
  });

  it("shows no hourly lines for somebody who only earned commission", () => {
    expect(person({}).hourly).toEqual([]);
    expect(person({}).hourlyRateCents).toBe(1800);
  });
});

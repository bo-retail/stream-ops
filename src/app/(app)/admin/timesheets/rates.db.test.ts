/**
 * Saving the pay rates, against a real database.
 *
 * The arithmetic is tested in `lib/domain/payroll.test.ts`. This is the form's
 * save: what it refuses, what it writes, and what it leaves alone — the five
 * rates live in two tables, and a save that wrote one and not the other would
 * pay somebody a rate nobody can see on the screen.
 *
 * Writes to the database, so it only runs when asked, and only on a local one:
 *
 *   STREAMOPS_DB_TESTS=1 npx vitest run rates.db
 *
 * Without that it skips, the same way the real-files suite does.
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.DATABASE_URL ?? "";
const enabled =
  process.env.STREAMOPS_DB_TESTS === "1" && /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

let actor = { id: "", role: "BOSS" as const };
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/guards", () => ({ requireBossOrThrow: async () => actor }));

const DOMAIN = "@rates-db-test.test";
const BASE = {
  streamerHourly: "18.00",
  diamondStreamerHourly: "22.00",
  shippingHourly: "16.00",
  commissionPercent: "1",
  diamondCommissionPercent: "1.5",
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

(enabled ? describe : describe.skip)("saving the pay rates", async () => {
  const { prisma } = await import("@/lib/db");
  const { setRates } = await import("./actions");
  const { getPayrollPeriod } = await import("@/lib/server/payroll");

  /** Every rate as stored: Settings, then [hourly, commission] per business. */
  const stored = async () => ({
    settings: await prisma.settings.findUniqueOrThrow({
      where: { id: "singleton" },
      select: { streamerHourlyCents: true, shippingHourlyCents: true, streamerCommissionBps: true },
    }),
    business: Object.fromEntries(
      (await prisma.businessSettings.findMany()).map((r) => [
        r.business,
        [r.streamerHourlyCents, r.streamerCommissionBps],
      ]),
    ),
  });
  const auditCount = () => prisma.auditLog.count({ where: { actorId: actor.id } });

  let settingsBefore: Awaited<ReturnType<typeof prisma.settings.findUniqueOrThrow>>;
  let businessBefore: Awaited<ReturnType<typeof prisma.businessSettings.findMany>>;

  beforeAll(async () => {
    settingsBefore = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
    businessBefore = await prisma.businessSettings.findMany();
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    const boss = await prisma.user.create({
      data: { email: `boss${DOMAIN}`, name: "Rates Test Boss", passwordHash: "x", role: "BOSS" },
    });
    actor = { id: boss.id, role: "BOSS" };
    expect((await setRates({}, form(BASE))).error).toBeUndefined();
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: actor.id } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        streamerHourlyCents: settingsBefore.streamerHourlyCents,
        shippingHourlyCents: settingsBefore.shippingHourlyCents,
        streamerCommissionBps: settingsBefore.streamerCommissionBps,
      },
    });
    for (const r of businessBefore) {
      const rates = { streamerCommissionBps: r.streamerCommissionBps, streamerHourlyCents: r.streamerHourlyCents };
      await prisma.businessSettings.upsert({
        where: { business: r.business },
        create: { business: r.business, ...rates },
        update: rates,
      });
    }
    await prisma.$disconnect();
  });

  it("writes every rate where payroll reads it, and keeps the fallback in step", async () => {
    const s = await stored();
    expect(s.business).toEqual({ WATCH: [1800, 100], DIAMOND: [2200, 150] });
    expect(s.settings).toEqual({ streamerHourlyCents: 1800, shippingHourlyCents: 1600, streamerCommissionBps: 100 });
    const run = await getPayrollPeriod("1990-01-01", "1990-01-01");
    expect(run.rates.streamerHourlyCents).toBe(1800);
    expect(run.rates.diamondStreamerHourlyCents).toBe(2200);
  });

  it("refuses a blank diamond hourly and writes nothing", async () => {
    const before = await stored();
    const r = await setRates({}, form({ ...BASE, diamondStreamerHourly: "" }));
    expect(r.error).toMatch(/diamond streamer hourly/);
    expect(await stored()).toEqual(before);
  });

  it("refuses a form from before the change, missing the diamond box", async () => {
    // A page left open across the deploy posts the old form.
    const f = form(BASE);
    f.delete("diamondStreamerHourly");
    expect((await setRates({}, f)).error).toBe("Fill in all five rates.");
  });

  it("refuses mistyped and spreadsheet-damaged figures", async () => {
    const before = await stored();
    for (const v of ["22.o0", "-5", "abc", "1000.01", "17,50", "$1,750.00"]) {
      expect((await setRates({}, form({ ...BASE, diamondStreamerHourly: v }))).error).toBeTruthy();
    }
    expect(await stored()).toEqual(before);
  });

  it("treats the same figures typed differently as no change, and logs nothing", async () => {
    const n = await auditCount();
    const r = await setRates({}, form({ ...BASE, diamondStreamerHourly: " $22 " }));
    expect(r.ok).toBe("Nothing changed.");
    expect(await auditCount()).toBe(n);
  });

  it("changes only the diamond hourly when only that is changed, and logs before and after", async () => {
    const r = await setRates({}, form({ ...BASE, diamondStreamerHourly: "25" }));
    expect(r.ok).toMatch(/saved/);
    const s = await stored();
    expect(s.business).toEqual({ WATCH: [1800, 100], DIAMOND: [2500, 150] });
    expect(s.settings.streamerHourlyCents).toBe(1800);
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { actorId: actor.id },
      orderBy: { createdAt: "desc" },
    });
    expect(log.before).toMatchObject({ diamondStreamerHourlyCents: 2200 });
    expect(log.after).toMatchObject({ diamondStreamerHourlyCents: 2500 });
    await setRates({}, form(BASE));
  });

  it("falls back to the watch rate if the diamond row is missing, and a save puts it back", async () => {
    await prisma.businessSettings.delete({ where: { business: "DIAMOND" } });
    const run = await getPayrollPeriod("1990-01-01", "1990-01-01");
    expect(run.rates.diamondStreamerHourlyCents).toBe(1800);
    expect((await setRates({}, form(BASE))).ok).toMatch(/saved/);
    expect((await stored()).business.DIAMOND).toEqual([2200, 150]);
  });

  it("leaves both tables agreeing when two admins save at once", async () => {
    await Promise.all([
      setRates({}, form({ ...BASE, streamerHourly: "19", diamondStreamerHourly: "23" })),
      setRates({}, form({ ...BASE, streamerHourly: "20", diamondStreamerHourly: "24" })),
    ]);
    const s = await stored();
    expect(s.settings.streamerHourlyCents).toBe(s.business.WATCH[0]);
    expect([
      [1900, 2300],
      [2000, 2400],
    ]).toContainEqual([s.business.WATCH[0], s.business.DIAMOND[0]]);
    await setRates({}, form(BASE));
  });
});

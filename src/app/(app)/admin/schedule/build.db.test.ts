/**
 * Build schedule puts in only people who said yes (Samuel, 10/14), against a
 * real database.
 *
 *   - only people who pressed Send, on the shows they offered, are placed
 *   - days tapped and never sent, someone who never answered, and a priority
 *     person who did not send are never placed
 *   - by hand, anyone can be picked; someone who did not send is warned about,
 *     and someone who sent "no shows" is told they did not offer it
 *   - a seat held by someone who did not send keeps its flag; publishing is
 *     still allowed
 *   - someone whose availability is handed back between the preview and the
 *     confirm is dropped
 *   - a release nobody has sent anything for fills nothing, and says why
 *
 * Written by the independent reviewer (10/14) and kept. Writes to the
 * database, so it only runs when asked, and only on a local one:
 *
 *   STREAMOPS_DB_TESTS=1 npx vitest run db.test
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.DATABASE_URL ?? "";
const enabled = process.env.STREAMOPS_DB_TESTS === "1" && /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

let boss: { id: string; name: string; role: "BOSS" } = { id: "", name: "", role: "BOSS" };
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/guards", () => ({ requireBossOrThrow: async () => boss }));

const FIX = "build-db-test";
const DOMAIN = "@build-db-test.test";
const DAY = "2027-05-05";
const t = (h: number) => new Date(Date.UTC(2027, 4, 5, h + 4));

(enabled ? describe : describe.skip)("Build schedule: only people who said yes", async () => {
  const { prisma } = await import("@/lib/db");
  const { toDbDate } = await import("@/lib/domain/dates");
  const { checkCandidate } = await import("@/lib/domain/schedule");
  const { getReleaseView, toShowInput } = await import("@/lib/server/schedule");
  const { generateSchedule, commitSchedule } = await import("./actions");

  const U: Record<string, { id: string; name: string }> = {};
  let releaseId = "";
  let dayShow = "";
  let nightShow = "";

  async function clean() {
    const ids = (await prisma.release.findMany({ where: { name: { startsWith: FIX } }, select: { id: true } })).map((r) => r.id);
    if (ids.length > 0) {
      await prisma.assignment.deleteMany({ where: { show: { releaseId: { in: ids } } } });
      await prisma.availability.deleteMany({ where: { releaseId: { in: ids } } });
      await prisma.availabilitySubmission.deleteMany({ where: { releaseId: { in: ids } } });
      await prisma.releasePriority.deleteMany({ where: { releaseId: { in: ids } } });
      await prisma.releaseMember.deleteMany({ where: { releaseId: { in: ids } } });
      await prisma.show.deleteMany({ where: { releaseId: { in: ids } } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
      await prisma.release.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  }

  const person = (name: string) =>
    prisma.user.create({
      data: { name, email: `${name.toLowerCase()}${DOMAIN}`, role: "EMPLOYEE", team: "STREAMING", isActive: true, passwordHash: "x" },
      select: { id: true, name: true },
    });

  async function release(suffix: string, business: "WATCH" | "DIAMOND" = "WATCH") {
    const r = await prisma.release.create({
      data: { name: `${FIX} ${suffix}`, business, startDate: toDbDate(DAY), endDate: toDbDate(DAY), status: "OPEN", scheduleStatus: "DRAFT", usePriority: true },
    });
    const d = await prisma.show.create({ data: { releaseId: r.id, business, date: toDbDate(DAY), platform: "TIKTOK", slot: "DAY", startsAt: t(10), endsAt: t(16) } });
    const n = await prisma.show.create({ data: { releaseId: r.id, business, date: toDbDate(DAY), platform: "TIKTOK", slot: "NIGHT", startsAt: t(17), endsAt: t(23) } });
    for (const u of Object.values(U)) await prisma.releaseMember.create({ data: { releaseId: r.id, userId: u.id } });
    return { id: r.id, day: d.id, night: n.id };
  }
  const offer = (rid: string, userId: string, slot: string) =>
    prisma.availability.create({ data: { releaseId: rid, userId, business: "WATCH", date: toDbDate(DAY), slot } });
  const send = (rid: string, userId: string) => prisma.availabilitySubmission.create({ data: { releaseId: rid, userId } });
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const who = (id: string) => Object.entries(U).find(([, u]) => u.id === id)?.[0];
  const names = (picks: { userId: string; showId: string; seat: number }[]) =>
    picks.map((p) => `${p.showId === dayShow ? "DAY" : "NIGHT"}${p.seat}:${who(p.userId)}`).sort();

  beforeAll(async () => {
    await clean();
    const b = await person("BuildBoss");
    boss = { ...b, role: "BOSS" };
    for (const n of ["Sent", "SentNight", "Tapped", "Never", "Prio", "SentZero"]) U[n] = await person(`Build${n}`);
    const r = await release("main");
    releaseId = r.id;
    dayShow = r.day;
    nightShow = r.night;
    await offer(releaseId, U.Sent.id, "DAY");
    await send(releaseId, U.Sent.id);
    await offer(releaseId, U.SentNight.id, "NIGHT");
    await send(releaseId, U.SentNight.id);
    await offer(releaseId, U.Tapped.id, "DAY");
    await offer(releaseId, U.Tapped.id, "NIGHT");
    await offer(releaseId, U.Prio.id, "DAY");
    await offer(releaseId, U.Prio.id, "NIGHT");
    await prisma.releasePriority.create({ data: { releaseId, userId: U.Prio.id, rank: 5 } });
    await send(releaseId, U.SentZero.id);
  });
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  it("places only people who sent, on the shows they offered", async () => {
    const res = await generateSchedule({}, form({ releaseId }));
    expect(names(res.proposal!.picks)).toEqual(["DAY1:Sent", "NIGHT1:SentNight"]);
  });

  it("by hand: everyone can be picked, with the right warning", async () => {
    const view = (await getReleaseView(releaseId))!;
    const shows = view.shows.map(toShowInput);
    const day = shows.find((x) => x.id === dayShow)!;
    const said = (name: string) =>
      checkCandidate(U[name].id, day, {
        assignments: [],
        shows,
        availability: view.availability.map((a) => ({ userId: a.userId, dateISO: a.dateISO, slot: a.slot })),
        timeOffByUser: view.timeOffByUser,
        elsewhere: view.elsewhere,
        submittedUserIds: view.submittedUserIds,
      });
    expect(said("Sent")).toEqual({ ok: true });
    expect(said("SentNight").reason).toBe("Did not offer this show");
    expect(said("SentZero").reason).toBe("Did not offer this show");
    for (const n of ["Tapped", "Never", "Prio"]) {
      expect(said(n)).toEqual({ ok: true, reason: "Hasn't sent in availability", severity: "warning" });
    }
  });

  it("handed back between the preview and the confirm: that pick is dropped", async () => {
    const res = await generateSchedule({}, form({ releaseId }));
    await prisma.availabilitySubmission.deleteMany({ where: { releaseId, userId: U.Sent.id } });
    await commitSchedule(
      {},
      form({ releaseId, picks: JSON.stringify(res.proposal!.picks.map((p) => ({ showId: p.showId, seat: p.seat, userId: p.userId }))) }),
    );
    const rows = await prisma.assignment.findMany({ where: { show: { releaseId } }, select: { userId: true, showId: true, seat: true } });
    expect(names(rows)).toEqual(["NIGHT1:SentNight"]);
    await prisma.assignment.deleteMany({ where: { show: { releaseId } } });
    await send(releaseId, U.Sent.id);
  });

  it("a seat held by someone who did not send keeps its flag; publishing is still allowed", async () => {
    await prisma.assignment.create({ data: { showId: dayShow, userId: U.Never.id, seat: 2 } });
    await prisma.assignment.create({ data: { showId: nightShow, userId: U.SentZero.id, seat: 2 } });
    await prisma.assignment.create({ data: { showId: nightShow, userId: U.Tapped.id, seat: 1 } });
    const view = (await getReleaseView(releaseId))!;
    const flags = [...view.validation.warnings, ...view.validation.errors]
      .filter((w) => w.code === "NOT_AVAILABLE")
      .map((w) => [who(w.userId!), w.message.includes("has not sent") ? "not sent" : w.message.includes("did not offer") ? "did not offer" : w.message]);
    expect(flags.sort()).toEqual([
      ["Never", "not sent"],
      ["SentZero", "did not offer"],
      ["Tapped", "not sent"],
    ]);
    expect(view.validation.canPublish).toBe(true);
    await prisma.assignment.deleteMany({ where: { show: { releaseId } } });
  });

  it("nobody has sent anything: nothing filled, and it says why", async () => {
    const r = await release("empty", "DIAMOND");
    await prisma.availability.create({ data: { releaseId: r.id, userId: U.Tapped.id, business: "DIAMOND", date: toDbDate(DAY), slot: "DAY" } });
    const res = await generateSchedule({}, form({ releaseId: r.id }));
    expect(res.proposal).toBeUndefined();
    expect(res.error).toContain("sent in their availability");
  });
});

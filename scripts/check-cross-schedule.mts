/**
 * A watch schedule and a diamond schedule must see each other.
 *
 * They are built on separate screens but can cover the same days at the same
 * hours — on 09/15 the diamond show ran 10:32–16:01 against the watch day
 * show's 10:06–16:05. Every check used to see one release only, so somebody on
 * a published diamond show could offer, be picked, be auto-filled and be
 * published onto an overlapping watch show without a word.
 *
 * Walks one person — on a diamond morning show — through the watch release:
 * the picker, publishing, the auto-fill's busy list, and her own availability
 * screen, with the diamond schedule both published and still a draft.
 *
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-cross-schedule.mts
 *
 * Everything it creates is removed at the end, including on the failure paths.
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { blockerFor } from "../src/lib/domain/assign";
import { checkCandidate } from "../src/lib/domain/schedule";
import { getAvailabilityForRelease, takenElsewhere } from "../src/lib/server/availability";
import { busyPeriods, getReleaseView, planCopyLastRelease, toShowInput } from "../src/lib/server/schedule";

assertDevDatabase("check-cross-schedule.mts");

const FIXTURE = "check-cross-schedule";
const DOMAIN = "@check-cross-schedule.test";
// Far from any real release, so nothing here meets real data.
const DAY = "2027-03-10";
// 10:30 and 16:00 Eastern (EST, UTC-5, in March before the change).
const t = (h: number, m = 0) => new Date(Date.UTC(2027, 2, 10, h + 5, m));

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

async function cleanUp() {
  const releases = await prisma.release.findMany({ where: { name: { startsWith: FIXTURE } }, select: { id: true } });
  const ids = releases.map((r) => r.id);
  if (ids.length > 0) {
    await prisma.assignment.deleteMany({ where: { show: { releaseId: { in: ids } } } });
    await prisma.availability.deleteMany({ where: { releaseId: { in: ids } } });
    await prisma.releaseMember.deleteMany({ where: { releaseId: { in: ids } } });
    await prisma.show.deleteMany({ where: { releaseId: { in: ids } } });
    await prisma.release.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

try {
  await cleanUp();

  const person = (name: string) =>
    prisma.user.create({
      data: {
        name,
        email: `${name.toLowerCase()}${DOMAIN}`,
        role: "EMPLOYEE",
        team: "STREAMING",
        isActive: true,
        passwordHash: "check-cross-schedule-fixture",
      },
      select: { id: true, name: true },
    });
  const maria = await person("Maria");
  const dani = await person("Dani");

  /* A published diamond schedule: Maria on the morning TikTok show. */
  const diamond = await prisma.release.create({
    data: {
      name: `${FIXTURE} diamond`,
      business: "DIAMOND",
      startDate: toDbDate(DAY),
      endDate: toDbDate(DAY),
      status: "CLOSED",
      scheduleStatus: "PUBLISHED",
      version: 1,
      publishedAt: new Date(),
    },
  });
  const diamondShow = await prisma.show.create({
    data: {
      releaseId: diamond.id, business: "DIAMOND", date: toDbDate(DAY),
      platform: "TIKTOK", slot: "DAY", status: "SCHEDULED", startsAt: t(10, 30), endsAt: t(16),
    },
  });
  await prisma.assignment.create({ data: { showId: diamondShow.id, userId: maria.id, seat: 1 } });

  /* A watch release being answered: a day show that overlaps, a night that does not. */
  const watch = await prisma.release.create({
    data: {
      name: `${FIXTURE} watch`,
      business: "WATCH",
      startDate: toDbDate(DAY),
      endDate: toDbDate(DAY),
      status: "OPEN",
      scheduleStatus: "DRAFT",
    },
  });
  const watchDay = await prisma.show.create({
    data: {
      releaseId: watch.id, business: "WATCH", date: toDbDate(DAY),
      platform: "TIKTOK", slot: "DAY", status: "SCHEDULED", startsAt: t(13), endsAt: t(19),
    },
  });
  const watchNight = await prisma.show.create({
    data: {
      releaseId: watch.id, business: "WATCH", date: toDbDate(DAY),
      platform: "TIKTOK", slot: "NIGHT", status: "SCHEDULED", startsAt: t(19), endsAt: t(25),
    },
  });
  for (const u of [maria, dani]) {
    await prisma.releaseMember.create({ data: { releaseId: watch.id, userId: u.id } });
  }

  /* ------------------------------------------------ the builder */

  let view = (await getReleaseView(watch.id))!;
  const mine = view.elsewhere.filter((e) => e.userId === maria.id);
  check("the watch builder sees Maria's diamond show", mine.map((e) => e.label), [`Diamond TikTok Day on ${DAY}`]);

  const shows = view.shows.map(toShowInput);
  const pick = (userId: string, showId: string) =>
    checkCandidate(userId, shows.find((s) => s.id === showId)!, {
      assignments: [],
      shows,
      elsewhere: view.elsewhere,
    });
  check("the picker greys her out of the overlapping watch show", pick(maria.id, watchDay.id), {
    ok: false,
    reason: `Already on Diamond TikTok Day on ${DAY}`,
    severity: "error",
  });
  check("but offers her the watch night show, which does not overlap", pick(maria.id, watchNight.id).ok, true);
  check("and leaves Dani, who is on nothing, free for both", [pick(dani.id, watchDay.id).ok, pick(dani.id, watchNight.id).ok], [true, true]);

  const blocked = blockerFor(
    { userId: maria.id, offeredThisShow: true, daysOff: [], assigned: 0, maxShows: null },
    { dateISO: DAY, startsAt: t(13), endsAt: t(19), onThisShow: new Set(), placed: busyPeriods(view) },
  );
  check("the auto-fill will not place her on it", blocked?.code, "CLASH");

  // Put her on it anyway, by hand, and the schedule must refuse to publish.
  await prisma.assignment.create({ data: { showId: watchDay.id, userId: maria.id, seat: 1 } });
  view = (await getReleaseView(watch.id))!;
  check("publishing is blocked", view.validation.canPublish, false);
  check(
    "saying where she already is",
    view.validation.errors.some((e) => e.message.includes(`Diamond TikTok Day on ${DAY}`)),
    true,
  );
  await prisma.assignment.deleteMany({ where: { showId: watchDay.id } });

  /* ------------------------------------------------ her availability */

  check("her availability shows the overlapping watch show as taken", (await takenElsewhere(maria.id, watch.id)).get(`${DAY}|DAY`), "Diamond TikTok Day");
  check("but not the night show", (await takenElsewhere(maria.id, watch.id)).has(`${DAY}|NIGHT`), false);
  const screen = await getAvailabilityForRelease(maria.id, watch.id);
  check(
    "and the screen says so on that tile",
    screen?.options.map((o) => [o.slot, o.takenBy]),
    [["DAY", "Diamond TikTok Day"], ["NIGHT", null]],
  );
  check("nothing is taken for Dani", (await takenElsewhere(dani.id, watch.id)).size, 0);

  /* ------------------------------------------ copying the last release */

  /*
    The traps "Copy last release" could fall into:
      - a diamond release that ended MORE recently than the last watch one,
        which "whichever ended most recently" would copy from;
      - Lee, on the last watch release but not sent this one;
      - Maria, whose copied morning seat now overlaps her diamond show.
    Only Dani's night seat should come across.
  */
  const lee = await person("Lee");
  const gemma = await person("Gemma");
  const PREV = "2027-03-03"; // the Wednesday before, like DAY
  const prevT = (h: number) => new Date(Date.UTC(2027, 2, 3, h + 5));
  const prevWatch = await prisma.release.create({
    data: {
      name: `${FIXTURE} previous watch`, business: "WATCH",
      startDate: toDbDate(PREV), endDate: toDbDate(PREV),
      status: "CLOSED", scheduleStatus: "PUBLISHED", version: 1, publishedAt: new Date(),
    },
  });
  const prevDay = await prisma.show.create({
    data: {
      releaseId: prevWatch.id, business: "WATCH", date: toDbDate(PREV),
      platform: "TIKTOK", slot: "DAY", status: "SCHEDULED", startsAt: prevT(13), endsAt: prevT(19),
    },
  });
  const prevNight = await prisma.show.create({
    data: {
      releaseId: prevWatch.id, business: "WATCH", date: toDbDate(PREV),
      platform: "TIKTOK", slot: "NIGHT", status: "SCHEDULED", startsAt: prevT(19), endsAt: prevT(25),
    },
  });
  await prisma.assignment.createMany({
    data: [
      { showId: prevDay.id, userId: maria.id, seat: 1 },
      { showId: prevDay.id, userId: lee.id, seat: 2 },
      { showId: prevNight.id, userId: dani.id, seat: 1 },
    ],
  });
  const prevDiamond = await prisma.release.create({
    data: {
      name: `${FIXTURE} previous diamond`, business: "DIAMOND",
      startDate: toDbDate(PREV), endDate: toDbDate("2027-03-05"),
      status: "CLOSED", scheduleStatus: "PUBLISHED", version: 1, publishedAt: new Date(),
    },
  });
  const prevDiamondDay = await prisma.show.create({
    data: {
      releaseId: prevDiamond.id, business: "DIAMOND", date: toDbDate(PREV),
      platform: "TIKTOK", slot: "DAY", status: "SCHEDULED", startsAt: prevT(13), endsAt: prevT(19),
    },
  });
  await prisma.assignment.create({ data: { showId: prevDiamondDay.id, userId: gemma.id, seat: 1 } });

  const plan = await planCopyLastRelease(watch.id);
  check("copy-forward finds something to copy", "error" in plan ? plan.error : "ok", "ok");
  if (!("error" in plan)) {
    check(
      "it copies from the last WATCH release, never the diamond one — Gemma is not brought across",
      plan.toCreate.some((c) => c.userId === gemma.id),
      false,
    );
    check(
      "only Dani's night seat comes across",
      plan.toCreate.map((c) => [c.showId === watchNight.id ? "night" : "day", c.userId === dani.id ? "Dani" : "?", c.seat]),
      [["night", "Dani", 1]],
    );
    check("Lee is left out — this release was not sent to him", plan.skipped, 1);
    check("Maria is left out — her copied morning seat overlaps her diamond show", plan.clashing, 1);
  }

  /* ------------------------------------------ a diamond draft */

  await prisma.release.update({ where: { id: diamond.id }, data: { scheduleStatus: "DRAFT" } });
  view = (await getReleaseView(watch.id))!;
  check(
    "the boss's builder still sees an unpublished diamond schedule, and says so",
    view.elsewhere.filter((e) => e.userId === maria.id).map((e) => e.label),
    [`Diamond TikTok Day on ${DAY} (not published yet)`],
  );
  check("but her own screen does not hint at a draft", (await takenElsewhere(maria.id, watch.id)).size, 0);

  /* ------------------------------------------ a cancelled show frees her */

  await prisma.release.update({ where: { id: diamond.id }, data: { scheduleStatus: "PUBLISHED" } });
  await prisma.show.update({ where: { id: diamondShow.id }, data: { status: "CANCELLED" } });
  view = (await getReleaseView(watch.id))!;
  check("a cancelled diamond show leaves her free", pick(maria.id, watchDay.id).ok, true);
  check("on her screen too", (await takenElsewhere(maria.id, watch.id)).size, 0);
} finally {
  console.log("\nCleaning up.");
  await cleanUp();
  const left = await prisma.release.count({ where: { name: { startsWith: FIXTURE } } });
  console.log(`Removed — ${left} fixture release(s) left.`);
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll cross-schedule checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

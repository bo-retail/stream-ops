/**
 * Proves the one thing selling diamonds depends on: two shows that look
 * identical can exist on the same date, as long as they are different kinds.
 *
 * Both sell on TikTok at the same hours — on 09/15 diamonds ran 10:32-16:01
 * Pacific against the watch day show's 10:06-16:05 — so "TikTok Day on the
 * 18th" names two different shows. The old unique key allowed exactly one of
 * them in the world, and the second one saved was refused by the database with
 * nothing in the app able to explain why.
 *
 * Everything this creates is removed at the end, including on the paths that
 * fail.
 *
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-two-businesses.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, toDbDate, todayISO } from "../src/lib/domain/dates";
import { getSettings } from "../src/lib/server/settings";
import { listReleaseCast } from "../src/lib/server/releases";
import { getPayrollPeriod } from "../src/lib/server/payroll";

assertDevDatabase("check-two-businesses.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

const settings = await getSettings();
const today = todayISO(settings.timezone);

/*
  A date far enough out that the real schedule has nothing on it. A show is
  unique on (business, date, platform, slot), so landing on a real one would
  collide and the script would die rather than tell you anything.
*/
const DATE = addDays(today, 400);
const PREFIX = "check: two businesses ";

async function clear() {
  await prisma.salesRecord.deleteMany({ where: { orderRef: { startsWith: PREFIX } } });
  await prisma.importBatch.deleteMany({ where: { showDate: toDbDate(DATE) } });
  const releases = await prisma.release.deleteMany({ where: { name: { startsWith: PREFIX } } });
  return releases.count;
}

const stale = await clear();
if (stale > 0) console.log(`Cleared ${stale} leftover(s) from an earlier run.\n`);

const created: string[] = [];

try {
  /* ------------------------------------------- one release of each kind */

  const make = async (business: "WATCH" | "DIAMOND") => {
    const release = await prisma.release.create({
      data: {
        name: `${PREFIX}${business.toLowerCase()}`,
        business,
        startDate: toDbDate(DATE),
        endDate: toDbDate(DATE),
      },
      select: { id: true },
    });
    created.push(release.id);
    return release.id;
  };

  const watchRelease = await make("WATCH");
  const diamondRelease = await make("DIAMOND");
  check("two releases can cover the same date", created.length, 2);

  /* -------------------- the same-looking show, once for each business */

  const addShow = (releaseId: string, business: "WATCH" | "DIAMOND") =>
    prisma.show.create({
      data: {
        releaseId,
        business,
        date: toDbDate(DATE),
        platform: "TIKTOK",
        slot: "DAY",
        startsAt: new Date(`${DATE}T17:00:00.000Z`),
        endsAt: new Date(`${DATE}T23:00:00.000Z`),
      },
      select: { id: true },
    });

  await addShow(watchRelease, "WATCH");
  await addShow(diamondRelease, "DIAMOND");

  check(
    "a watch TikTok Day and a diamond TikTok Day coexist on one date",
    await prisma.show.count({ where: { date: toDbDate(DATE), platform: "TIKTOK", slot: "DAY" } }),
    2,
  );

  /* ----------------------- and the key still does its original job */

  console.log("\n(the next few lines are Prisma reporting a refusal we asked for)\n");
  let refused = false;
  try {
    // The same kind twice is still one show too many. This is what stops two
    // overlapping releases both claiming it.
    await addShow(diamondRelease, "DIAMOND");
  } catch {
    refused = true;
  }
  console.log("");
  check("but the same kind twice is still refused", refused, true);

  /* ------------------------------------------- who may be seated on it */

  const everyone = await listReleaseCast(watchRelease);
  check("a release with nobody chosen offers everybody", everyone.length > 0, true);

  const streamer = everyone[0];
  if (streamer) {
    await prisma.releaseMember.create({ data: { releaseId: diamondRelease, userId: streamer.id } });
    const cast = await listReleaseCast(diamondRelease);
    check("choosing one person narrows the seat picker to them", cast.length, 1);
    check("and it is the right person", cast[0]?.id, streamer.id);
    check(
      "the other release is untouched by that choice",
      (await listReleaseCast(watchRelease)).length,
      everyone.length,
    );
  } else {
    console.log("SKIP  seat picker checks — no active streamers on this database.");
  }

  /* --------------------------------------------- rates, one set each */

  const rates = await prisma.businessSettings.findMany({ orderBy: { business: "asc" } });
  check("both kinds of show have their own rates", rates.length, 2);
  check(
    "and each can be moved without the other",
    rates.every((r) => r.seatsPerShow >= 1 && r.streamerCommissionBps >= 0),
    true,
  );

  /* ------------------------------------- the money, which is the whole point */

  /*
    Two shows on one date, identical but for the business, each with its own
    pair and its own takings.

    Keyed without the business these pooled into one bucket: the takings were
    added together and whichever rota row was read last overwrote who was on it,
    so one pair earned commission on both shows and the other earned nothing.
    This is the check that says that cannot happen.
  */
  const streamers = await prisma.user.findMany({
    where: { isActive: true, role: "EMPLOYEE", team: "STREAMING" },
    orderBy: { name: "asc" },
    take: 4,
    select: { id: true, name: true },
  });

  if (streamers.length < 4) {
    console.log("\nSKIP  payroll separation — needs four active streamers on this database.");
  } else {
    const [w1, w2, d1, d2] = streamers;

    const watchShow = await prisma.show.findFirstOrThrow({
      where: { releaseId: watchRelease },
      select: { id: true },
    });
    const diamondShow = await prisma.show.findFirstOrThrow({
      where: { releaseId: diamondRelease },
      select: { id: true },
    });

    await prisma.assignment.createMany({
      data: [
        { showId: watchShow.id, userId: w1.id, seat: 1 },
        { showId: watchShow.id, userId: w2.id, seat: 2 },
        { showId: diamondShow.id, userId: d1.id, seat: 1 },
        { showId: diamondShow.id, userId: d2.id, seat: 2 },
      ],
    });

    // One upload per business, as the two seller accounts produce.
    const sale = async (business: "WATCH" | "DIAMOND", cents: number) => {
      const batch = await prisma.importBatch.create({
        data: {
          business,
          showDate: toDbDate(DATE),
          status: "OK",
          files: [{ name: `${PREFIX}${business}.csv`, platform: "TIKTOK" }],
          flags: [],
        },
        select: { id: true },
      });
      await prisma.salesRecord.create({
        data: {
          batchId: batch.id,
          business,
          platform: "TIKTOK",
          show: "TikTok AM",
          showDate: toDbDate(DATE),
          shiftTag: "",
          rawShiftTag: "",
          orderRef: `${PREFIX}${business}`,
          lineRef: "",
          buyer: "",
          stockNumber: "X1",
          netItemPriceCents: cents,
          sourceFile: `${PREFIX}${business}.csv`,
        },
      });
      return batch.id;
    };

    await sale("WATCH", 100_000); // $1,000
    await sale("DIAMOND", 50_000); // $500

    const payroll = await getPayrollPeriod(DATE, DATE);
    const earned = (userId: string) =>
      payroll.people.find((p) => p.userId === userId)?.commissionCents ?? -1;

    const watchRate = rates.find((r) => r.business === "WATCH")!.streamerCommissionBps;
    const diamondRate = rates.find((r) => r.business === "DIAMOND")!.streamerCommissionBps;

    check("the watch pair earn on their show only", earned(w1.id), Math.round((100_000 * watchRate) / 10_000));
    check("both of them, separately", earned(w2.id), earned(w1.id));
    check(
      "the diamond pair earn on theirs only",
      earned(d1.id),
      Math.round((50_000 * diamondRate) / 10_000),
    );
    check("both of them too", earned(d2.id), earned(d1.id));
    check("and the two shows are not the same show", earned(w1.id) === earned(d1.id), false);

    check(
      "both shows appear on the run, neither swallowed",
      payroll.shows.filter((s) => s.key.dateISO === DATE).length,
      2,
    );
    check(
      "each with its own takings",
      payroll.shows
        .filter((s) => s.key.dateISO === DATE)
        .map((s) => s.netRevenueCents)
        .sort((a, b) => a - b),
      [50_000, 100_000],
    );
  }
} finally {
  console.log("\nCleaning up.");
  // Cascades take the shows and the members with the releases.
  await clear();
  const left = await prisma.show.count({ where: { date: toDbDate(DATE) } });
  console.log(`Removed — ${left} show(s) left on ${DATE}.`);
  if (left > 0) failures++;
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll two-business checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

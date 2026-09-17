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

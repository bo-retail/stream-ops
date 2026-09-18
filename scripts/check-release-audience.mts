/**
 * The list of people a release is sent to must decide who is asked.
 *
 * That list is the point of picking it: a diamond release goes to the people
 * who work diamonds and lands on nobody else's page. It used to be read by the
 * seat picker and by nothing else, so sending a diamond release to two people
 * put it in front of all seventeen streamers, asking each of them to fill in a
 * show they do not work — and the boss's "0 of 17 answered" could never be
 * reached, because fifteen of those seventeen were never asked.
 *
 * Three separate things have to agree, which is why they are all checked here:
 * the page that lists somebody's requests, the server actions that save their
 * answer, and the count the boss reads. A page that merely declines to show
 * something is not the same as a server that will not accept it.
 *
 * Everything this creates is removed at the end, including on the paths that
 * fail.
 *
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-release-audience.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, toDbDate, todayISO } from "../src/lib/domain/dates";
import { getOpenReleasesForUser, getDefaultRelease } from "../src/lib/server/availability";
import { getReleaseSummary, isAskedAbout, listReleaseCast } from "../src/lib/server/releases";

assertDevDatabase("check-release-audience.mts");

const FIXTURE = "check-release-audience";
const DOMAIN = "@check-release-audience.test";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

async function cleanUp() {
  const releases = await prisma.release.findMany({
    where: { name: { startsWith: FIXTURE } },
    select: { id: true },
  });
  const ids = releases.map((r) => r.id);
  if (ids.length > 0) {
    await prisma.availability.deleteMany({ where: { releaseId: { in: ids } } });
    await prisma.availabilitySubmission.deleteMany({ where: { releaseId: { in: ids } } });
    await prisma.releaseMember.deleteMany({ where: { releaseId: { in: ids } } });
    await prisma.assignment.deleteMany({ where: { show: { releaseId: { in: ids } } } });
    await prisma.show.deleteMany({ where: { releaseId: { in: ids } } });
    await prisma.release.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

try {
  await cleanUp();

  /* Four streamers of our own, so the check does not depend on real people. */
  const names = ["Diamond One", "Diamond Two", "Watch One", "Watch Two"];
  const people = [];
  for (const name of names) {
    people.push(
      await prisma.user.create({
        data: {
          name,
          email: `${name.toLowerCase().replace(/ /g, ".")}${DOMAIN}`,
          role: "EMPLOYEE",
          team: "STREAMING",
          isActive: true,
          // Never signed in to, and deleted at the end. Not a usable hash.
          passwordHash: "check-release-audience-fixture",
        },
        select: { id: true, name: true },
      }),
    );
  }
  const [d1, d2, w1, w2] = people;

  const start = addDays(todayISO("America/New_York"), 400);
  const end = addDays(start, 6);

  /* A diamond release, sent to two of the four. */
  const diamond = await prisma.release.create({
    data: {
      name: `${FIXTURE} diamond`,
      business: "DIAMOND",
      startDate: toDbDate(start),
      endDate: toDbDate(end),
      status: "OPEN",
      scheduleStatus: "DRAFT",
    },
  });
  for (const u of [d1, d2]) {
    await prisma.releaseMember.create({ data: { releaseId: diamond.id, userId: u.id } });
  }
  await prisma.show.create({
    data: {
      releaseId: diamond.id,
      business: "DIAMOND",
      date: toDbDate(start),
      platform: "TIKTOK",
      slot: "DAY",
      status: "SCHEDULED",
      startsAt: new Date(`${start}T17:00:00.000Z`),
      endsAt: new Date(`${start}T23:00:00.000Z`),
    },
  });

  const sees = async (userId: string) =>
    (await getOpenReleasesForUser(userId))
      .filter((r) => r.release.name?.startsWith(FIXTURE))
      .map((r) => r.release.name);

  check("the people it was sent to are asked", await sees(d1.id), [`${FIXTURE} diamond`]);
  check("both of them", await sees(d2.id), [`${FIXTURE} diamond`]);
  check("somebody it was not sent to is not asked", await sees(w1.id), []);
  check("nor the other one", await sees(w2.id), []);

  /* The server must refuse the answer too, not merely decline to offer it. */
  check("the server accepts an answer from somebody asked", await isAskedAbout(d1.id, diamond.id), true);
  check(
    "and refuses one from somebody who was not",
    await isAskedAbout(w1.id, diamond.id),
    false,
  );

  /* The boss's count is out of who was asked, so it can actually be reached. */
  const summary = await getReleaseSummary(diamond.id);
  check("the boss is told it went to two people, not the whole team", summary?.askedCount, 2);

  await prisma.availabilitySubmission.create({
    data: { releaseId: diamond.id, userId: d1.id, submittedAt: new Date() },
  });
  await prisma.availabilitySubmission.create({
    data: { releaseId: diamond.id, userId: d2.id, submittedAt: new Date() },
  });
  const answered = await getReleaseSummary(diamond.id);
  check(
    "and with both of them in, it reads as complete",
    `${answered?.submittedCount} of ${answered?.askedCount}`,
    "2 of 2",
  );

  /*
    Somebody who answered and was then taken off the list. Their submission is
    still on record, and counting it would read "2 of 1" — out of step with the
    Requests list, which no longer shows them.
  */
  await prisma.releaseMember.deleteMany({ where: { releaseId: diamond.id, userId: d2.id } });
  const narrowed = await getReleaseSummary(diamond.id);
  check(
    "an answer from somebody taken off the list no longer counts",
    `${narrowed?.submittedCount} of ${narrowed?.askedCount}`,
    "1 of 1",
  );
  await prisma.releaseMember.create({ data: { releaseId: diamond.id, userId: d2.id } });

  /* The seat picker already worked; it must still agree with all of the above. */
  const cast = (await listReleaseCast(diamond.id)).map((c) => c.name).sort();
  check("only those two can be seated on it", cast, ["Diamond One", "Diamond Two"]);

  /*
    A release built before there was a list of people. Those genuinely did go to
    the whole team, and must keep working exactly as they did.
  */
  const legacy = await prisma.release.create({
    data: {
      name: `${FIXTURE} legacy`,
      business: "WATCH",
      startDate: toDbDate(addDays(start, 30)),
      endDate: toDbDate(addDays(start, 36)),
      status: "OPEN",
      scheduleStatus: "DRAFT",
    },
  });
  await prisma.show.create({
    data: {
      releaseId: legacy.id,
      business: "WATCH",
      date: toDbDate(addDays(start, 30)),
      platform: "TIKTOK",
      slot: "DAY",
      status: "SCHEDULED",
      startsAt: new Date(`${addDays(start, 30)}T17:00:00.000Z`),
      endsAt: new Date(`${addDays(start, 30)}T23:00:00.000Z`),
    },
  });

  check(
    "a release with nobody chosen still goes to everybody",
    (await sees(w1.id)).includes(`${FIXTURE} legacy`),
    true,
  );
  check("including the diamond pair", (await sees(d1.id)).sort(), [
    `${FIXTURE} diamond`,
    `${FIXTURE} legacy`,
  ]);
  const legacySummary = await getReleaseSummary(legacy.id);
  check(
    "and is counted against the whole team",
    (legacySummary?.askedCount ?? 0) >= 4,
    true,
  );

  /* Landing on the right one: never a release they were not sent. */
  const landing = await getDefaultRelease(w2.id);
  check("somebody lands on a release they were asked about", landing !== diamond.id, true);
} finally {
  console.log("\nCleaning up.");
  await cleanUp();
  const left = await prisma.release.count({ where: { name: { startsWith: FIXTURE } } });
  console.log(`Removed — ${left} fixture release(s) left.`);
  await prisma.$disconnect();
}

console.log(
  failures === 0 ? "\nAll release-audience checks passed." : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);

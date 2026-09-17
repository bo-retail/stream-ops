/**
 * Proves the missing-report banner fires on exactly the right days.
 *
 * The rule has four clauses and every one of them is a judgement that would be
 * wrong in a different direction: chase a day too early and the director is
 * told off for a report that does not exist yet; too late and a day's sales
 * quietly never get recorded.
 *
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-show-days.mts
 *
 * Everything it creates is removed at the end.
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, toDbDate, todayISO } from "../src/lib/domain/dates";
import { getSettings } from "../src/lib/server/settings";
import { listShowDays, missingReportDays, missingReports } from "../src/lib/server/shipping";

assertDevDatabase("check-show-days.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

const settings = await getSettings();
const today = todayISO(settings.timezone);

/*
  Days inside the look-back window that have no real shows on them.

  A show is unique on (date, platform, slot), so a fixture on a day the business
  actually ran collides and the script dies on a constraint violation rather
  than telling you anything. Fixed offsets from today cannot avoid that: what
  they land on changes as the date rolls over, and after launch every recent day
  has shows on it — which is exactly when somebody would run this against a copy
  of production to check something.

  So the days are chosen rather than assumed. Three free ones are needed inside
  the fourteen-day window this feature looks back over; the fixtures have to be
  in it for the test to mean anything, which is why they cannot simply be moved
  to last year.
*/
const WINDOW = 14;
const candidates = Array.from({ length: WINDOW }, (_, i) => addDays(today, -(i + 1)));
const taken = new Set(
  (
    await prisma.show.findMany({
      where: { date: { in: candidates.map(toDbDate) } },
      select: { date: true },
      distinct: ["date"],
    })
  ).map((s) => s.date.toISOString().slice(0, 10)),
);
const free = candidates.filter((d) => !taken.has(d));

if (free.length < 3) {
  console.log(
    `SKIP  need three days in the last ${WINDOW} with no shows on them; only ${free.length} are free.\n` +
      `      Every other day already has a real schedule, and a fixture would collide with it.`,
  );
  await prisma.$disconnect();
  process.exit(0);
}

const [HAS_SHOWS_NO_REPORT, ALL_CANCELLED, NEVER_PUBLISHED] = free;
const TOO_OLD = addDays(today, -40);

/** A release covering one date, with two shows on it. */
async function makeDay(
  dateISO: string,
  opts: { published: boolean; cancelled: boolean; name: string },
) {
  const release = await prisma.release.create({
    data: {
      name: opts.name,
      startDate: toDbDate(dateISO),
      endDate: toDbDate(dateISO),
      status: opts.published ? "CLOSED" : "DRAFT",
      scheduleStatus: opts.published ? "PUBLISHED" : "DRAFT",
      shows: {
        create: (["TIKTOK", "EBAY"] as const).map((platform) => ({
          date: toDbDate(dateISO),
          platform,
          slot: "DAY" as const,
          startsAt: new Date(`${dateISO}T17:00:00.000Z`),
          endsAt: new Date(`${dateISO}T23:00:00.000Z`),
          status: opts.cancelled ? ("CANCELLED" as const) : ("SCHEDULED" as const),
        })),
      },
    },
    select: { id: true },
  });
  return release.id;
}

/**
 * Anything left behind by a run that died before its own cleanup.
 *
 * Run at both ends, because a half-cleaned database fails the next run in two
 * confusing ways: a leftover release collides on the (date, platform, slot)
 * unique index, and a leftover batch makes a day look like its report already
 * arrived — so the check that matters most reports the opposite of the truth.
 *
 * Batches are matched on being empty as well as on the date. A real import
 * always has files and watches behind it, so this cannot reach one.
 */
const FIXTURE_PREFIX = "check: ";
const FIXTURE_DATES = [HAS_SHOWS_NO_REPORT, ALL_CANCELLED, NEVER_PUBLISHED, TOO_OLD, today];

async function clearFixtures() {
  const releases = await prisma.release.deleteMany({
    where: { name: { startsWith: FIXTURE_PREFIX } },
  });
  const batches = await prisma.importBatch.deleteMany({
    where: {
      showDate: { in: FIXTURE_DATES.map(toDbDate) },
      watchCount: 0,
      boxCount: 0,
    },
  });
  return releases.count + batches.count;
}

const stale = await clearFixtures();
if (stale > 0) console.log(`Cleared ${stale} leftover(s) from an earlier run.\n`);

const created: string[] = [];
created.push(await makeDay(HAS_SHOWS_NO_REPORT, { published: true, cancelled: false, name: "check: needs a report" }));
created.push(await makeDay(ALL_CANCELLED, { published: true, cancelled: true, name: "check: all cancelled" }));
created.push(await makeDay(NEVER_PUBLISHED, { published: false, cancelled: false, name: "check: still a draft" }));
/*
  Today needs published shows for "today is never chased" to mean anything. On a
  real schedule it almost always has them already, and a fixture would collide
  with them on the (date, platform, slot) index — which is how this script used
  to die on any copy of production. Real shows test the rule just as well.
*/
const todayHasShows =
  (await prisma.show.count({
    where: { date: toDbDate(today), status: "SCHEDULED", release: { scheduleStatus: "PUBLISHED" } },
  })) > 0;
if (!todayHasShows) {
  created.push(await makeDay(today, { published: true, cancelled: false, name: "check: today" }));
}
created.push(await makeDay(TOO_OLD, { published: true, cancelled: false, name: "check: long ago" }));

console.log("Built five show days to test the rule against.\n");

const missing = await missingReportDays();

check("a published day with shows and no report is chased", missing.includes(HAS_SHOWS_NO_REPORT), true);
check("a day whose shows were all cancelled is not", missing.includes(ALL_CANCELLED), false);
check("a day that was never published is not", missing.includes(NEVER_PUBLISHED), false);
check("today is not — its shows have not finished", missing.includes(today), false);
check("a day outside the look-back window is not", missing.includes(TOO_OLD), false);

/* ------------------------------------------- a refused upload is not a report */

const blocked = await prisma.importBatch.create({
  data: {
    showDate: toDbDate(HAS_SHOWS_NO_REPORT),
    status: "BLOCKED",
    files: [],
    flags: [{ severity: "blocking", message: "check fixture" }],
  },
  select: { id: true },
});
check(
  "a refused upload does not count as a report",
  (await missingReportDays()).includes(HAS_SHOWS_NO_REPORT),
  true,
);

/* -------------------------------- a report without one marketplace is not done */

// 09/11 went in with its TikTok exports and no eBay one, and read as loaded.
const partial = await prisma.importBatch.create({
  data: {
    showDate: toDbDate(HAS_SHOWS_NO_REPORT),
    status: "OK",
    // After the refused upload above: the day list shows the most recent attempt.
    uploadedAt: new Date(Date.now() + 1_000),
    files: [{ name: "check-tiktok.csv", platform: "TIKTOK" }],
    flags: [],
  },
  select: { id: true },
});
const partialRow = (await missingReports()).find((m) => m.dateISO === HAS_SHOWS_NO_REPORT);
check("a report with TikTok and no eBay is still chased", partialRow !== undefined, true);
check("naming what is missing", partialRow?.missing, "the eBay export");
check(
  "and the day list says so too",
  (await listShowDays()).find((d) => d.dateISO === HAS_SHOWS_NO_REPORT)?.missing,
  "the eBay export",
);

const ok = await prisma.importBatch.create({
  data: {
    showDate: toDbDate(HAS_SHOWS_NO_REPORT),
    status: "OK",
    uploadedAt: new Date(Date.now() + 2_000),
    files: [
      { name: "check-tiktok.csv", platform: "TIKTOK" },
      { name: "check-ebay.csv", platform: "EBAY" },
    ],
    flags: [],
  },
  select: { id: true },
});
check(
  "a successful one clears it",
  (await missingReportDays()).includes(HAS_SHOWS_NO_REPORT),
  false,
);

/* ------------------------------------------------------------ the day list */

const days = await listShowDays();
const row = days.find((d) => d.dateISO === HAS_SHOWS_NO_REPORT);
check("the day list finds it", row !== undefined, true);
check("with both its live shows", row?.liveShows, 2);
check("and shows the latest upload, not the refused one", row?.report?.status, "OK");
check("with nothing missing from it", row?.missing, null);
check("the cancelled day reports no live shows", days.find((d) => d.dateISO === ALL_CANCELLED)?.liveShows, 0);
check("the list is newest first", days[0]?.dateISO, today);
check("with nothing refused after it", row?.refusedAfter, null);

/* ------------------------- a refusal after a good report does not erase it */

/*
  09/16 on the live system: the watch files loaded and made 315 boxes, then a
  diamond file was uploaded and correctly refused. The day then read "Refused"
  with an empty watches column while 315 real boxes were being packed against
  the good report — because the newest upload won whatever became of it.

  A refused upload creates nothing, so it cannot be what the day says. It is
  reported alongside instead.
*/
const refusedLater = await prisma.importBatch.create({
  data: {
    showDate: toDbDate(HAS_SHOWS_NO_REPORT),
    status: "BLOCKED",
    uploadedAt: new Date(Date.now() + 3_000),
    files: [{ name: "check-someone-elses.csv", platform: "TIKTOK" }],
    flags: [{ severity: "blocking", message: "check fixture" }],
  },
  select: { id: true },
});

const afterRefusal = (await listShowDays()).find((d) => d.dateISO === HAS_SHOWS_NO_REPORT);
check("the day still shows its good report", afterRefusal?.report?.status, "OK");
check("and still its figures, not the refusal's", afterRefusal?.report?.batchId, ok.id);
check("the refusal is reported separately", afterRefusal?.refusedAfter?.batchId, refusedLater.id);
check("and the day is not chased again", (await missingReportDays()).includes(HAS_SHOWS_NO_REPORT), false);

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleaning up.");
await prisma.importBatch.deleteMany({
  where: { id: { in: [blocked.id, partial.id, ok.id, refusedLater.id] } },
});
await clearFixtures();

const left = await prisma.release.count({ where: { id: { in: created } } });
console.log(`Removed — ${left} fixture releases left.`);

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll show-day checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

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
import { listShowDays, missingReportDays } from "../src/lib/server/shipping";

assertDevDatabase("check-show-days.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

const settings = await getSettings();
const today = todayISO(settings.timezone);

const HAS_SHOWS_NO_REPORT = addDays(today, -2);
const ALL_CANCELLED = addDays(today, -3);
const NEVER_PUBLISHED = addDays(today, -4);
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
created.push(await makeDay(today, { published: true, cancelled: false, name: "check: today" }));
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

const ok = await prisma.importBatch.create({
  data: { showDate: toDbDate(HAS_SHOWS_NO_REPORT), status: "OK", files: [], flags: [] },
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
check("the cancelled day reports no live shows", days.find((d) => d.dateISO === ALL_CANCELLED)?.liveShows, 0);
check("the list is newest first", days[0]?.dateISO, today);

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleaning up.");
await prisma.importBatch.deleteMany({ where: { id: { in: [blocked.id, ok.id] } } });
await clearFixtures();

const left = await prisma.release.count({ where: { id: { in: created } } });
console.log(`Removed — ${left} fixture releases left.`);

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll show-day checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

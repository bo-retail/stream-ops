/**
 * Streamers' hours come from the published schedule, not from a clock.
 *
 * The rules this proves, in the order they matter:
 *
 *   printed when the show starts, not before, and only from a published release
 *   printed once, however many times anything asks
 *   the hours are the show's, both people on it
 *   editing the show afterwards does not move anybody's pay
 *   the boss can correct them, and the correction stands
 *   shipping is untouched
 *
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-scheduled-hours.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { getEntriesInRange, materialiseScheduledHours, scheduledHoursPrinted } from "../src/lib/server/timeclock";

assertDevDatabase("check-scheduled-hours.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

const FIXTURE = "check-scheduled-hours";

/*
  Well clear of anything real.

  A show is unique on (date, platform, slot), so a fixture on yesterday collides
  with whatever actually ran yesterday. Sixty days back is inside the ninety-day
  window a catch-up run reaches, and outside any live schedule.
*/
const DATE = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
const FUTURE = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

/** Removes anything an earlier run left behind, so this is re-runnable. */
async function clearFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: "@check-scheduled-hours.test" } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await prisma.timeEntryRevision.deleteMany({ where: { timeEntry: { userId: { in: ids } } } });
    await prisma.timeEntry.deleteMany({ where: { userId: { in: ids } } });
  }
  await prisma.release.deleteMany({ where: { name: { startsWith: FIXTURE } } });
  if (ids.length > 0) await prisma.user.deleteMany({ where: { id: { in: ids } } });
}
await clearFixtures();

/* --------------------------------------------------------------- fixtures */

const [alice, bob, packer] = await Promise.all(
  [
    { name: "Alice Streamer", team: "STREAMING" as const },
    { name: "Bob Streamer", team: "STREAMING" as const },
    { name: "Pat Packer", team: "SHIPPING" as const },
  ].map((p, i) =>
    prisma.user.create({
      data: {
        name: p.name,
        email: `p${i}@check-scheduled-hours.test`,
        passwordHash: "x",
        role: "EMPLOYEE",
        team: p.team,
      },
      select: { id: true },
    }),
  ),
);

/** A show, with both seats filled, on a release that may or may not be published. */
async function makeShow(opts: {
  dateISO: string;
  published: boolean;
  startsAt: Date;
  endsAt: Date;
  platform: "TIKTOK" | "EBAY";
  slot: "DAY" | "NIGHT";
}) {
  const release = await prisma.release.create({
    data: {
      name: `${FIXTURE} ${opts.dateISO} ${opts.platform} ${opts.slot}`,
      startDate: toDbDate(opts.dateISO),
      endDate: toDbDate(opts.dateISO),
      status: "CLOSED",
      scheduleStatus: opts.published ? "PUBLISHED" : "DRAFT",
      shows: {
        create: {
          date: toDbDate(opts.dateISO),
          platform: opts.platform,
          slot: opts.slot,
          startsAt: opts.startsAt,
          endsAt: opts.endsAt,
          assignments: {
            create: [
              { userId: alice.id, seat: 1 },
              { userId: bob.id, seat: 2 },
            ],
          },
        },
      },
    },
    select: { shows: { select: { id: true } } },
  });
  return release.shows[0].id;
}

// Ran, 19:00 to 01:00 — six hours, crossing midnight the way a night show does.
const ranStart = new Date(`${DATE}T19:00:00.000Z`);
const ranEnd = new Date(ranStart.getTime() + 6 * 3_600_000);
const ran = await makeShow({ dateISO: DATE, published: true, startsAt: ranStart, endsAt: ranEnd, platform: "TIKTOK", slot: "NIGHT" });

// Published, but has not started yet.
const future = await makeShow({
  dateISO: FUTURE,
  published: true,
  startsAt: new Date(Date.now() + 45 * 86_400_000),
  endsAt: new Date(Date.now() + 45 * 86_400_000 + 6 * 3_600_000),
  platform: "TIKTOK",
  slot: "DAY",
});

// Started, but the release was never published.
const draft = await makeShow({
  dateISO: DATE,
  published: false,
  startsAt: ranStart,
  endsAt: ranEnd,
  platform: "EBAY",
  slot: "NIGHT",
});

// Started an hour ago, still on air. Its own date so it cannot collide with
// anything real; only `startsAt` decides whether hours are due.
const IN_PROGRESS_DATE = new Date(Date.now() - 59 * 86_400_000).toISOString().slice(0, 10);
const onAirStart = new Date(Date.now() - 3_600_000);
const onAirEnd = new Date(Date.now() + 5 * 3_600_000);
const onAir = await makeShow({
  dateISO: IN_PROGRESS_DATE,
  published: true,
  startsAt: onAirStart,
  endsAt: onAirEnd,
  platform: "TIKTOK",
  slot: "DAY",
});

console.log("Built four shows: one that ran, one on air now, one still to come, one never published.\n");

/* --------------------------------------------------------------- printing */

const printed = await materialiseScheduledHours();
check("hours were printed", printed >= 2, true);
check("both people on the show got them", await scheduledHoursPrinted(ran), 2);
check("a show that has not started yet gets nothing", await scheduledHoursPrinted(future), 0);
check("nor does one on an unpublished release", await scheduledHoursPrinted(draft), 0);

// The whole point of the question: payroll is not pre-filled with a pay
// period's worth of shows nobody has worked yet.
const futureEntries = await prisma.timeEntry.count({
  where: { showId: future, source: "SCHEDULE" },
});
check("no entry exists for a future show at all", futureEntries, 0);

// A show on air now has started, so its hours are printed — the whole shift,
// not the hour of it that has elapsed. That is what "as the show starts"
// means, and it matches how a night show has always been attributed to the
// day it began on rather than split across midnight.
check("a show on air now has its hours printed", await scheduledHoursPrinted(onAir), 2);
const onAirView = await prisma.timeEntry.findFirstOrThrow({
  where: { showId: onAir, userId: alice.id },
  select: { clockInAt: true, clockOutAt: true },
});
check("for the full shift, not the part already elapsed", onAirView.clockOutAt?.toISOString(), onAirEnd.toISOString());

const again = await materialiseScheduledHours();
check("running it again prints nothing", again, 0);
check("and there is still one entry each", await scheduledHoursPrinted(ran), 2);

const entry = await prisma.timeEntry.findFirstOrThrow({
  where: { showId: ran, userId: alice.id },
  select: { clockInAt: true, clockOutAt: true, source: true, showId: true, revisions: true },
});
check("the entry holds the show's hours", entry.clockInAt.toISOString(), ranStart.toISOString());
check("start to finish", entry.clockOutAt?.toISOString(), ranEnd.toISOString());
check("marked as coming from the schedule", entry.source, "SCHEDULE");
check("with its first version on record", entry.revisions.length, 1);
check("saying where it came from", entry.revisions[0].reason, "Printed from the published schedule");

const view = await getEntriesInRange({ from: DATE, to: DATE, userId: alice.id });
check("it reads as six hours", view[0]?.paidMinutes, 360);
check("and is flagged as scheduled rather than clocked", view[0]?.fromSchedule, true);
check("with nothing docked for lateness that never applied", [view[0]?.lateMinutes, view[0]?.leftEarlyMinutes], [0, 0]);

/* ---------------------------------------------- the show changes afterwards */

await prisma.show.update({
  where: { id: ran },
  data: { endsAt: new Date(ranEnd.getTime() + 3_600_000) },
});
await materialiseScheduledHours();

const afterEdit = await getEntriesInRange({ from: DATE, to: DATE, userId: alice.id });
check("stretching the show does not move pay already printed", afterEdit[0]?.paidMinutes, 360);
check("and does not print a second entry", await scheduledHoursPrinted(ran), 2);

/* ------------------------------------------------- the boss corrects them */

// Somebody left an hour early. The correction has to stand, not be quietly
// clamped back up to the show's hours.
const shortened = new Date(ranEnd.getTime() - 3_600_000);
await prisma.timeEntry.updateMany({
  where: { showId: ran, userId: alice.id },
  data: { clockOutAt: shortened, source: "ADMIN", version: 2 },
});

const corrected = await getEntriesInRange({ from: DATE, to: DATE, userId: alice.id });
check("a correction is paid as corrected", corrected[0]?.paidMinutes, 300);
check("and is not clamped back up to the show's hours", corrected[0]?.paidMinutes !== 360, true);

/* ------------------------------------------------------------- shipping */

check("shipping is never given scheduled hours", await prisma.timeEntry.count({ where: { userId: packer.id } }), 0);

/* ------------------------------- a show somebody already clocked, the old way */

/*
  The one that would have doubled a pay period.

  Before hours came from the schedule, a streamer clocked in and out and the
  entry carried the show it was measured against. Those entries are still there.
  If a catch-up run only looked for its own SCHEDULE entries, it would print a
  second set of hours over the top of every show anybody had ever clocked — and
  the first page load after deploying reaches ninety days back.
*/
const CLOCKED_DATE = new Date(Date.now() - 57 * 86_400_000).toISOString().slice(0, 10);
const clockedStart = new Date(`${CLOCKED_DATE}T19:00:00.000Z`);
const clockedEnd = new Date(clockedStart.getTime() + 6 * 3_600_000);
const clockedShow = await makeShow({
  dateISO: CLOCKED_DATE,
  published: true,
  startsAt: clockedStart,
  endsAt: clockedEnd,
  platform: "TIKTOK",
  slot: "DAY",
});

// Alice clocked it herself, the way it used to work. Bob's was corrected by an
// admin. Neither should be printed over.
await prisma.timeEntry.create({
  data: {
    userId: alice.id,
    showId: clockedShow,
    clockInAt: clockedStart,
    clockOutAt: clockedEnd,
    source: "SELF",
    version: 1,
  },
});
await prisma.timeEntry.create({
  data: {
    userId: bob.id,
    showId: clockedShow,
    clockInAt: clockedStart,
    clockOutAt: new Date(clockedEnd.getTime() - 3_600_000),
    source: "ADMIN",
    version: 2,
  },
});

await materialiseScheduledHours();

check(
  "a show somebody clocked is not printed over",
  await prisma.timeEntry.count({ where: { showId: clockedShow, userId: alice.id } }),
  1,
);
check(
  "nor one an admin corrected",
  await prisma.timeEntry.count({ where: { showId: clockedShow, userId: bob.id } }),
  1,
);
check(
  "and no schedule entry was printed for either",
  await scheduledHoursPrinted(clockedShow),
  0,
);
check(
  "the admin's correction still stands",
  (
    await prisma.timeEntry.findFirstOrThrow({
      where: { showId: clockedShow, userId: bob.id },
      select: { clockOutAt: true },
    })
  ).clockOutAt?.toISOString(),
  new Date(clockedEnd.getTime() - 3_600_000).toISOString(),
);

/* ------------------------------------------------------- somebody leaves */

/*
  The case that used to lose money.

  Hours were only printed for accounts that were, at that moment, an active
  streamer. Deactivate a leaver on their last day — or move them onto shipping —
  before anything had loaded a page, and the shows they had already worked
  stopped being printed and were never paid. Nothing said so.

  Their assignments are deliberately left in place when they move, so the show
  still names them; only the account changed.
*/
const LEAVER_DATE = new Date(Date.now() - 58 * 86_400_000).toISOString().slice(0, 10);
const leftStart = new Date(`${LEAVER_DATE}T19:00:00.000Z`);
const leftEnd = new Date(leftStart.getTime() + 5 * 3_600_000);
const worked = await makeShow({
  dateISO: LEAVER_DATE,
  published: true,
  startsAt: leftStart,
  endsAt: leftEnd,
  platform: "EBAY",
  slot: "DAY",
});

// Alice is deactivated and Bob is moved onto shipping, both before anything has
// printed the show they just worked.
await prisma.user.update({ where: { id: alice.id }, data: { isActive: false } });
await prisma.user.update({ where: { id: bob.id }, data: { team: "SHIPPING" } });

await materialiseScheduledHours();
check("a leaver is still paid for the show they worked", await scheduledHoursPrinted(worked), 2);

const leaverEntry = await prisma.timeEntry.findFirst({
  where: { showId: worked, userId: alice.id },
  select: { clockInAt: true, clockOutAt: true },
});
check("for the show's full hours", leaverEntry?.clockOutAt?.toISOString(), leftEnd.toISOString());
check(
  "and the one who moved to shipping is paid too",
  await prisma.timeEntry.count({ where: { showId: worked, userId: bob.id, source: "SCHEDULE" } }),
  1,
);

// Put them back so the rest of the fixture teardown is unsurprising.
await prisma.user.update({ where: { id: alice.id }, data: { isActive: true } });
await prisma.user.update({ where: { id: bob.id }, data: { team: "STREAMING" } });

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleaning up.");
await clearFixtures();
console.log(`Removed — ${await prisma.user.count({ where: { email: { endsWith: "@check-scheduled-hours.test" } } })} fixture accounts left.`);

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll scheduled-hours checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

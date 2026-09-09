/**
 * What deleting a release may and may not take with it.
 *
 * The line: hours this schedule printed are the schedule's to take back, with
 * an explanation. Hours somebody clocked by hand are a record of their own day
 * and are not.
 *
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-release-delete.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { materialiseScheduledHours } from "../src/lib/server/timeclock";

assertDevDatabase("check-release-delete.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

const FIXTURE = "check-release-delete";
const EMAIL = "@check-release-delete.test";

async function clearFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: EMAIL } },
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

const [alice, bob] = await Promise.all(
  ["Alice", "Bob"].map((name, i) =>
    prisma.user.create({
      data: {
        name: `${name} Fixture`,
        email: `p${i}${EMAIL}`,
        passwordHash: "x",
        role: "EMPLOYEE",
        team: "STREAMING",
      },
      select: { id: true },
    }),
  ),
);

/** A published release whose show ran, on a date nothing real uses. */
async function makeRanRelease(daysAgo: number, slot: "DAY" | "NIGHT") {
  const dateISO = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const startsAt = new Date(Date.now() - daysAgo * 86_400_000);
  const release = await prisma.release.create({
    data: {
      name: `${FIXTURE} ${dateISO} ${slot}`,
      startDate: toDbDate(dateISO),
      endDate: toDbDate(dateISO),
      status: "CLOSED",
      scheduleStatus: "PUBLISHED",
      shows: {
        create: {
          date: toDbDate(dateISO),
          platform: "TIKTOK",
          slot,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 6 * 3_600_000),
          assignments: {
            create: [
              { userId: alice.id, seat: 1 },
              { userId: bob.id, seat: 2 },
            ],
          },
        },
      },
    },
    select: { id: true, shows: { select: { id: true } } },
  });
  return { releaseId: release.id, showId: release.shows[0].id };
}

/* --------------------------------------------- printed hours, no clocking */

const a = await makeRanRelease(50, "NIGHT");
await materialiseScheduledHours();

const impactA = await prisma.timeEntry.groupBy({
  by: ["source"],
  where: { show: { releaseId: a.releaseId } },
  _count: { _all: true },
});
check("the show printed hours for both people", impactA.find((r) => r.source === "SCHEDULE")?._count._all, 2);
check("and nobody clocked anything", impactA.find((r) => r.source === "SELF") ?? null, null);

// Deleting takes the printed hours back, but only with a reason. Exercised
// through the same queries the action uses; the action itself needs a session.
const clocked = await prisma.timeEntry.count({
  where: { show: { releaseId: a.releaseId }, source: "SELF" },
});
const scheduled = await prisma.timeEntry.count({
  where: { show: { releaseId: a.releaseId }, source: { in: ["SCHEDULE", "ADMIN"] } },
});
check("nothing blocks the delete", clocked, 0);
check("but two paid entries would go with it", scheduled, 2);

// The order matters: entries first, because deleting a show sets their showId
// to null rather than removing them, which would strand them paid.
const ids = (
  await prisma.timeEntry.findMany({
    where: { show: { releaseId: a.releaseId }, source: { in: ["SCHEDULE", "ADMIN"] } },
    select: { id: true },
  })
).map((e) => e.id);
await prisma.timeEntryRevision.deleteMany({ where: { timeEntryId: { in: ids } } });
await prisma.timeEntry.deleteMany({ where: { id: { in: ids } } });
await prisma.release.delete({ where: { id: a.releaseId } });

check("the release is gone", await prisma.release.count({ where: { id: a.releaseId } }), 0);
check("and so are its hours", await prisma.timeEntry.count({ where: { id: { in: ids } } }), 0);
check(
  "with no entry left stranded and paid",
  await prisma.timeEntry.count({ where: { userId: alice.id, showId: null } }),
  0,
);

/* ------------------------------------------------ somebody clocked by hand */

const b = await makeRanRelease(49, "DAY");
await materialiseScheduledHours();
await prisma.timeEntry.create({
  data: {
    userId: alice.id,
    showId: b.showId,
    clockInAt: new Date(Date.now() - 49 * 86_400_000),
    clockOutAt: new Date(Date.now() - 49 * 86_400_000 + 3_600_000),
    source: "SELF",
    version: 2,
  },
});

const clockedB = await prisma.timeEntry.count({
  where: { show: { releaseId: b.releaseId }, source: "SELF" },
});
check("a hand-clocked entry is counted separately", clockedB, 1);
check(
  "and is what blocks the delete",
  clockedB > 0,
  true,
);
check(
  "the printed ones are still counted apart from it",
  await prisma.timeEntry.count({
    where: { show: { releaseId: b.releaseId }, source: { in: ["SCHEDULE", "ADMIN"] } },
  }),
  2,
);

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleaning up.");
await clearFixtures();
console.log(`Removed — ${await prisma.release.count({ where: { name: { startsWith: FIXTURE } } })} fixture releases left.`);

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll release-delete checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

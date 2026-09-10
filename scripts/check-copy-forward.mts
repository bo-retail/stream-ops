/**
 * Copying last release's people forward must not carry somebody who has left.
 *
 * The copy matches on weekday, platform and slot, and it used to take whatever
 * name it found. A streamer who has since been deactivated, or moved onto
 * shipping, would be placed on the new rota — and because their old assignments
 * are deliberately left alone when they move, there is always a name there to
 * find. The boss would then publish a schedule naming somebody who cannot work
 * it.
 *
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-copy-forward.mts
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { copyLastRelease } from "../src/app/(app)/admin/schedule/actions";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

const FIXTURE = "check-copy-forward";
const DOMAIN = "@check-copy-forward.test";

async function clearFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: DOMAIN } },
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

const boss = await prisma.user.findFirst({ where: { role: "BOSS", isActive: true }, select: { id: true } });
if (!boss) {
  console.log("SKIP  need an admin account. Run the seed first.");
  process.exit(0);
}

/* --------------------------------------------------------------- fixtures */

// Three streamers. One will leave, one will move to shipping, one stays.
const [leaver, mover, stayer] = await Promise.all(
  ["Lena Leaver", "Mo Mover", "Sam Stayer"].map((name, i) =>
    prisma.user.create({
      data: {
        name,
        email: `p${i}${DOMAIN}`,
        passwordHash: "x",
        role: "EMPLOYEE",
        team: "STREAMING",
      },
      select: { id: true },
    }),
  ),
);

/*
  Two releases a week apart, both on the same weekday so the copy has something
  to match. Far enough back that nothing real shares a (date, platform, slot).
*/
function backTo(days: number) {
  const d = new Date(Date.now() - days * 86_400_000);
  // Land on the same weekday for both by stepping in sevens.
  return d.toISOString().slice(0, 10);
}
const OLD = backTo(120);
const NEW = backTo(113);

async function makeRelease(dateISO: string, people: { id: string }[]) {
  return prisma.release.create({
    data: {
      name: `${FIXTURE} ${dateISO}`,
      startDate: toDbDate(dateISO),
      endDate: toDbDate(dateISO),
      status: "CLOSED",
      scheduleStatus: "DRAFT",
      shows: {
        create: {
          date: toDbDate(dateISO),
          platform: "TIKTOK",
          slot: "NIGHT",
          startsAt: new Date(`${dateISO}T19:00:00.000Z`),
          endsAt: new Date(`${dateISO}T23:00:00.000Z`),
          ...(people.length > 0
            ? { assignments: { create: people.map((p, i) => ({ userId: p.id, seat: i + 1 })) } }
            : {}),
        },
      },
    },
    select: { id: true, shows: { select: { id: true } } },
  });
}

const older = await makeRelease(OLD, [leaver, stayer]);
const newer = await makeRelease(NEW, []);
console.log(`Built two releases: ${OLD} with two people on it, ${NEW} empty.\n`);

/* ------------------------------------------- everybody is still a streamer */

const form = new FormData();
form.set("releaseId", newer.id);
const first = await copyLastRelease({}, form);
check("the copy runs", typeof first.ok === "string", true);
check(
  "both people came across",
  await prisma.assignment.count({ where: { showId: newer.shows[0].id } }),
  2,
);

/* ------------------------------------------------ one leaves, one moves on */

// Clear the target and change who these people are.
await prisma.assignment.deleteMany({ where: { showId: newer.shows[0].id } });
await prisma.assignment.deleteMany({ where: { showId: older.shows[0].id } });
await prisma.assignment.createMany({
  data: [
    { showId: older.shows[0].id, userId: leaver.id, seat: 1, assignedById: boss.id },
    { showId: older.shows[0].id, userId: mover.id, seat: 2, assignedById: boss.id },
  ],
});
await prisma.user.update({ where: { id: leaver.id }, data: { isActive: false } });
await prisma.user.update({ where: { id: mover.id }, data: { team: "SHIPPING" } });

const second = await copyLastRelease({}, new (class extends FormData {})());
// The empty form must be refused rather than copying onto some other release.
check("a copy with no release is refused", typeof second.error === "string", true);

const form2 = new FormData();
form2.set("releaseId", newer.id);
const third = await copyLastRelease({}, form2);

check(
  "nobody was carried forward",
  await prisma.assignment.count({ where: { showId: newer.shows[0].id } }),
  0,
);
check("and it says why rather than claiming success", typeof third.error === "string", true);
check(
  "naming the people it left out",
  (third.error ?? "").includes("no longer streamers"),
  true,
);

/* ------------------------- the old release still names them, as it should */

check(
  "the release they actually worked is untouched",
  await prisma.assignment.count({ where: { showId: older.shows[0].id } }),
  2,
);

/* ------------------------------------------ one of them comes back to work */

await prisma.user.update({ where: { id: mover.id }, data: { team: "STREAMING" } });
const form3 = new FormData();
form3.set("releaseId", newer.id);
const fourth = await copyLastRelease({}, form3);

check(
  "the one who came back is copied again",
  await prisma.assignment.count({ where: { showId: newer.shows[0].id } }),
  1,
);
check(
  "and the one still gone is not",
  await prisma.assignment.count({
    where: { showId: newer.shows[0].id, userId: leaver.id },
  }),
  0,
);
check("with the copy reporting what it skipped", (fourth.ok ?? "").includes("left out"), true);

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleaning up.");
await clearFixtures();
console.log(
  `Removed — ${await prisma.user.count({ where: { email: { endsWith: DOMAIN } } })} fixture accounts left.`,
);

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll copy-forward checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

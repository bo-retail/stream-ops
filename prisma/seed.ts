/**
 * Seeds the database.
 *
 * Always creates: settings and the first boss account.
 * With `--demo` (the default outside production): a team, an open period with
 * availability already submitted, and a published period of staffed shows — so
 * the builder has something real to show on first run.
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import type { Platform, Slot } from "../src/generated/prisma/enums";
import { hashPassword } from "../src/lib/auth/password";
import { resolveSlotInstants, toDbDate, todayISO } from "../src/lib/domain/dates";
import { nextPeriod, periodDates, periodFor } from "../src/lib/domain/periods";
import { PLATFORMS, SLOTS } from "../src/lib/domain/types";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const TZ = "America/New_York";
const DAY: [string, string] = ["13:00", "19:00"];
const NIGHT: [string, string] = ["19:00", "01:00"];

/** Deterministic PRNG so re-seeding produces the same demo data. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const random = makeRandom(20260903);

/**
 * The demo team. Priority is chosen per release now, so nobody carries a
 * standing one — the seed names two of them on the release it opens instead.
 */
const DEMO_TEAM: { name: string; team: "STREAMING" | "SHIPPING" }[] = [
  { name: "Maya Alvarez", team: "STREAMING" },
  { name: "Devon Clarke", team: "STREAMING" },
  { name: "Priya Raman", team: "STREAMING" },
  { name: "Jonah Weiss", team: "STREAMING" },
  { name: "Tasha Boyd", team: "STREAMING" },
  { name: "Luis Moreno", team: "STREAMING" },
  { name: "Erin Kowalski", team: "STREAMING" },
  { name: "Sam Okafor", team: "STREAMING" },
  { name: "Ray Nakamura", team: "SHIPPING" },
  { name: "Bea Whitlock", team: "SHIPPING" },
];

const emailFor = (name: string) => `${name.split(" ")[0].toLowerCase()}@streamops.local`;
const hoursFor = (slot: Slot) => (slot === "DAY" ? DAY : NIGHT);

async function main() {
  const wantsDemo =
    process.argv.includes("--demo") ||
    (process.env.NODE_ENV !== "production" && !process.argv.includes("--no-demo"));

  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: {
      id: "singleton",
      timezone: TZ,
    },
  });
  console.log("✓ settings");

  const bossEmail = (process.env.SEED_BOSS_EMAIL ?? "boss@streamops.local").toLowerCase();
  const bossPassword = process.env.SEED_BOSS_PASSWORD;
  if (!bossPassword) {
    throw new Error("SEED_BOSS_PASSWORD is not set — refusing to create an account without one.");
  }

  const boss = await prisma.user.upsert({
    where: { email: bossEmail },
    update: { role: "BOSS", isActive: true },
    create: {
      email: bossEmail,
      name: "Owner",
      role: "BOSS",
      passwordHash: await hashPassword(bossPassword),
      // SEED_BOSS_PASSWORD sits in an env var and in whatever shell history ran
      // this, so it gets you in once and is then replaced with one only the
      // admin knows. Only on create: re-seeding must not lock out a live admin.
      mustChangePassword: true,
    },
  });
  console.log(`✓ boss account: ${bossEmail}`);

  if (!wantsDemo) {
    console.log("Skipping demo data (pass --demo to include it).");
    return;
  }

  const employees: { id: string; name: string }[] = [];
  for (const member of DEMO_TEAM) {
    const user = await prisma.user.upsert({
      where: { email: emailFor(member.name) },
      update: { team: member.team },
      create: {
        email: emailFor(member.name),
        name: member.name,
        role: "EMPLOYEE",
        team: member.team,
        passwordHash: await hashPassword("ChangeMe123!"),
      },
    });
    if (member.team === "STREAMING") employees.push({ id: user.id, name: member.name });
  }
  console.log(`✓ ${DEMO_TEAM.length} people — ${employees.length} streaming, ${DEMO_TEAM.length - employees.length} shipping (password: ChangeMe123!)`);

  const current = periodFor(todayISO(TZ));
  const upcoming = nextPeriod(current);

  for (const period of [current, upcoming]) {
    const isCurrent = period.start === current.start;

    const existing = await prisma.release.findFirst({
      where: { startDate: toDbDate(period.start), endDate: toDbDate(period.end) },
      select: { id: true },
    });
    if (existing) {
      console.log(`· period ${period.start}–${period.end} already exists, leaving it alone`);
      continue;
    }

    const created = await prisma.release.create({
      data: {
        startDate: toDbDate(period.start),
        endDate: toDbDate(period.end),
        name: null,
        // The upcoming release is what the team is being asked about.
        status: isCurrent ? "CLOSED" : "OPEN",
        releasedAt: isCurrent ? null : new Date(),
        createdById: boss.id,
        usePriority: !isCurrent,
        useProportional: true,
      },
      select: { id: true },
    });

    // Switching the priority rule on without naming anybody would leave it doing
    // nothing at all, which reads as a bug rather than a setting. The upcoming
    // release names the first two streamers so the rule is visible on first run.
    if (!isCurrent && employees.length >= 2) {
      await prisma.releasePriority.createMany({
        data: [
          { releaseId: created.id, userId: employees[0].id, rank: 2 },
          { releaseId: created.id, userId: employees[1].id, rank: 1 },
        ],
        skipDuplicates: true,
      });
    }

    const dates = periodDates(period);

    // Four shows a day: both platforms, day and night.
    const showRows = dates.flatMap((dateISO) =>
      PLATFORMS.flatMap((platform) =>
        SLOTS.map((slot) => {
          const [start, end] = hoursFor(slot as Slot);
          const { startsAt, endsAt } = resolveSlotInstants(dateISO, start, end, TZ);
          return {
            releaseId: created.id,
            date: toDbDate(dateISO),
            platform: platform as Platform,
            slot: slot as Slot,
            startsAt,
            endsAt,
          };
        }),
      ),
    );
    await prisma.show.createMany({ data: showRows, skipDuplicates: true });

    // Availability, plus how many shows each person says they want. The spread
    // of requests is what makes the ranking visible on the builder.
    const availability = [];
    for (const [index, employee] of employees.entries()) {
      for (const dateISO of dates) {
        for (const slot of SLOTS) {
          if (random() < 0.35) continue; // not free for this one
          availability.push({
            userId: employee.id,
            releaseId: created.id,
            date: toDbDate(dateISO),
            slot: slot as Slot,
          });
        }
      }

      await prisma.availabilitySubmission.upsert({
        where: { userId_releaseId: { userId: employee.id, releaseId: created.id } },
        create: { userId: employee.id, releaseId: created.id },
        update: {},
      });
    }
    await prisma.availability.createMany({ data: availability, skipDuplicates: true });

    // Only the current period gets staffed and published; the next one is the
    // blank canvas the boss builds from.
    if (!isCurrent) {
      console.log(
        `✓ period ${period.start}–${period.end} (open for availability, nothing staffed yet)`,
      );
      continue;
    }

    const shows = await prisma.show.findMany({
      where: { releaseId: created.id },
      select: { id: true, startsAt: true, endsAt: true },
      orderBy: { startsAt: "asc" },
    });

    // Each seat starts scanning from a different point in the team, so the demo
    // shows people mixed across the period. A plain round-robin advancing by two
    // per show would lock the same four pairs together every single day, which
    // looks like a bug in the scheduler rather than a schedule.
    const assignments: { showId: string; userId: string; seat: number }[] = [];
    const placed: { userId: string; startsAt: Date; endsAt: Date }[] = [];

    for (const show of shows) {
      const onThisShow = new Set<string>();

      for (const seat of [1, 2]) {
        const start = Math.floor(random() * employees.length);
        let chosen: { id: string } | null = null;

        for (let attempt = 0; attempt < employees.length; attempt++) {
          const candidate = employees[(start + attempt) % employees.length];
          // A show needs two different people.
          if (onThisShow.has(candidate.id)) continue;
          const busy = placed.some(
            (p) =>
              p.userId === candidate.id &&
              p.startsAt.getTime() < show.endsAt.getTime() &&
              show.startsAt.getTime() < p.endsAt.getTime(),
          );
          if (busy) continue;
          chosen = candidate;
          break;
        }
        if (!chosen) continue;

        onThisShow.add(chosen.id);
        assignments.push({ showId: show.id, userId: chosen.id, seat });
        placed.push({ userId: chosen.id, startsAt: show.startsAt, endsAt: show.endsAt });
      }
    }

    await prisma.assignment.createMany({ data: assignments, skipDuplicates: true });

    // A couple of cancellations, so the demo shows what one looks like.
    const cancelled = shows.slice(-2).map((s) => s.id);
    await prisma.show.updateMany({
      where: { id: { in: cancelled } },
      data: { status: "CANCELLED", notes: "Nobody free" },
    });

    await prisma.release.update({
      where: { id: created.id },
      data: {
        scheduleStatus: "PUBLISHED",
        version: 1,
        publishedAt: new Date(),
        publishedById: boss.id,
      },
    });
    await prisma.scheduleSnapshot.create({
      data: {
        releaseId: created.id,
        version: 1,
        createdById: boss.id,
        payload: {
          publishedAt: new Date().toISOString(),
          showCount: shows.length,
          assignmentCount: assignments.length,
        },
      },
    });

    console.log(
      `✓ period ${period.start}–${period.end} (published, ${shows.length} shows, ${assignments.length} placed, ${cancelled.length} cancelled)`,
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

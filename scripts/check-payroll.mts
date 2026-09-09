/**
 * Payroll, against a real database.
 *
 * The unit tests cover the arithmetic. This covers the join, which is where the
 * money actually goes wrong: hours live on the timesheet, sales live in an
 * upload, and what connects them is the shift tag on a listing — not the show
 * the watch sold in. Getting that backwards pays the wrong team, and every
 * figure still looks plausible.
 *
 * Everything here is synthetic and on a date far in the past, so it cannot
 * collide with a real show (which is unique on date, platform and slot) or
 * touch a real upload.
 *
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-payroll.mts
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { getPayrollPeriod } from "../src/lib/server/payroll";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

const FIXTURE = "check-payroll";
const DOMAIN = "@check-payroll.test";

/* A day 100 days back: inside no live release, outside anything real. */
const DAY = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
const [Y, M, D] = DAY.split("-");
const TAG_DAY = `${M}.${D}.${Y.slice(2)}`;
const period = { start: DAY, end: DAY };

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
  await prisma.importBatch.deleteMany({ where: { showDate: toDbDate(DAY) } });
  if (ids.length > 0) await prisma.user.deleteMany({ where: { id: { in: ids } } });
}
await clearFixtures();

/* --------------------------------------------------------------- the rates */

const settingsBefore = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });

await prisma.settings.update({
  where: { id: "singleton" },
  data: {
    streamerHourlyCents: 1800, // $18.00
    shippingHourlyCents: 1600, // $16.00
    streamerCommissionBps: 100, // 1%
  },
});

/* ------------------------------------------------------------- the people */

const [maya, devon, ana, pat] = await Promise.all(
  [
    { name: "Maya Day", team: "STREAMING" as const, role: "EMPLOYEE" as const },
    { name: "Devon Day", team: "STREAMING" as const, role: "EMPLOYEE" as const },
    { name: "Ana Night", team: "STREAMING" as const, role: "EMPLOYEE" as const },
    { name: "Pat Packer", team: "SHIPPING" as const, role: "EMPLOYEE" as const },
  ].map((p, i) =>
    prisma.user.create({
      data: { ...p, email: `p${i}${DOMAIN}`, passwordHash: "x" },
      select: { id: true, name: true },
    }),
  ),
);

/* -------------------------------------------------------------- the shows */

async function makeShow(
  platform: "TIKTOK" | "EBAY",
  slot: "DAY" | "NIGHT",
  people: { id: string }[],
) {
  const startsAt = new Date(`${DAY}T${slot === "DAY" ? "17" : "23"}:00:00.000Z`);
  const endsAt = new Date(startsAt.getTime() + 6 * 3_600_000);
  const release = await prisma.release.create({
    data: {
      name: `${FIXTURE} ${platform} ${slot}`,
      startDate: toDbDate(DAY),
      endDate: toDbDate(DAY),
      status: "CLOSED",
      scheduleStatus: "PUBLISHED",
      shows: {
        create: {
          date: toDbDate(DAY),
          platform,
          slot,
          startsAt,
          endsAt,
          assignments: { create: people.map((p, i) => ({ userId: p.id, seat: i + 1 })) },
        },
      },
    },
    select: { shows: { select: { id: true } } },
  });
  return { id: release.shows[0].id, startsAt, endsAt };
}

// Maya and Devon on the TikTok day show; Ana alone on the TikTok night show.
const dayShow = await makeShow("TIKTOK", "DAY", [maya, devon]);
const nightShow = await makeShow("TIKTOK", "NIGHT", [ana]);

/* -------------------------------------------------------------- the sales */

const batch = await prisma.importBatch.create({
  data: {
    showDate: toDbDate(DAY),
    status: "OK",
    files: [],
    flags: [],
    watchCount: 0,
    boxCount: 0,
    droppedCount: 0,
  },
  select: { id: true },
});

let line = 0;
async function sale(opts: {
  platform: "TIKTOK" | "EBAY";
  show: string;
  shiftTag: string;
  cents: number;
}) {
  line++;
  await prisma.salesRecord.create({
    data: {
      batchId: batch.id,
      platform: opts.platform,
      show: opts.show,
      showDate: toDbDate(DAY),
      shiftTag: opts.shiftTag,
      rawShiftTag: opts.shiftTag,
      orderRef: `o${line}`,
      lineRef: `l${line}`,
      buyer: `buyer${line}`,
      stockNumber: `SKU${line}`,
      netItemPriceCents: opts.cents,
      sourceFile: "fixture.csv",
    },
  });
}

// $1,000 on the day show and $2,000 on the night show, both tagged plainly.
await sale({ platform: "TIKTOK", show: "TikTok AM", shiftTag: `${TAG_DAY} AM`, cents: 100_000 });
await sale({ platform: "TIKTOK", show: "TikTok PM", shiftTag: `${TAG_DAY} PM`, cents: 200_000 });

// $500 that SOLD on the night show but was LISTED for the day one. The tag is
// what is paid on, so this belongs to the day team — the case the whole
// shiftTag column exists for.
await sale({ platform: "TIKTOK", show: "TikTok PM", shiftTag: `${TAG_DAY} AM`, cents: 50_000 });

// $300 sold on eBay but tagged for the TikTok day show. The token wins over the
// marketplace the row came out of.
await sale({ platform: "EBAY", show: "eBay PM", shiftTag: `${TAG_DAY} TT AM`, cents: 30_000 });

// $700 tagged for an eBay show that nobody is rostered on.
await sale({ platform: "EBAY", show: "eBay PM", shiftTag: `${TAG_DAY} PM`, cents: 70_000 });

// $90 whose tag is gibberish. Nobody can be paid it.
await sale({ platform: "TIKTOK", show: "TikTok PM", shiftTag: "who knows", cents: 9_000 });

console.log(`Built two shows and six sales on ${DAY}.\n`);

/* --------------------------------------------------------------- the hours */

async function hours(userId: string, showId: string | null, startsAt: Date, hoursWorked: number) {
  await prisma.timeEntry.create({
    data: {
      userId,
      showId,
      clockInAt: startsAt,
      clockOutAt: new Date(startsAt.getTime() + hoursWorked * 3_600_000),
      source: showId ? "SCHEDULE" : "SELF",
      version: 1,
    },
  });
}

await hours(maya.id, dayShow.id, dayShow.startsAt, 6);
await hours(devon.id, dayShow.id, dayShow.startsAt, 6);
await hours(ana.id, nightShow.id, nightShow.startsAt, 6);
await hours(pat.id, null, new Date(`${DAY}T14:00:00.000Z`), 8);

/* ------------------------------------------------------------- the answer */

const run = await getPayrollPeriod(period.start, period.end);
const by = (name: string) => run.people.find((p) => p.name === name);

check("everybody who worked is on it", run.people.length, 4);

/* ---- the day show: $1,000 tagged AM + $500 that sold PM + $300 from eBay */

const daySales = 100_000 + 50_000 + 30_000; // $1,800
check(
  "a sale is paid on its shift tag, not on where it sold",
  run.shows.find((s) => s.key.slot === "DAY")?.netRevenueCents,
  daySales,
);
check("both people on the day show earn on it", by("Maya Day")?.shows.length, 1);
check("one per cent each", by("Maya Day")?.commissionCents, 1800);
check("and the same for the other one", by("Devon Day")?.commissionCents, 1800);

// 1% each, not 1% split: the show pays out 2% of its sales in total.
check(
  "the show pays out twice its rate in total",
  (by("Maya Day")?.commissionCents ?? 0) + (by("Devon Day")?.commissionCents ?? 0),
  Math.round(daySales * 0.02),
);

/* --------------------------------------- the night show: $2,000, one person */

check("the night show keeps only what is tagged for it", by("Ana Night")?.commissionCents, 2000);

/* ---------------------------------------------------------------- the hours */

check("six hours at $18", by("Maya Day")?.hourlyPayCents, 10_800);
check("plus commission", by("Maya Day")?.totalCents, 10_800 + 1800);
check("shipping is paid eight hours at $16", by("Pat Packer")?.hourlyPayCents, 12_800);
check("and earns no commission at all", by("Pat Packer")?.commissionCents, 0);
check("nor is credited with any show", by("Pat Packer")?.shows.length, 0);

/* ------------------------------------------------------------ what nobody earns */

check("sales for an unrostered show are reported", run.unattributed.length >= 1, true);
check(
  "including the $700 nobody is on",
  run.unattributed.some((s) => s.netRevenueCents === 70_000),
  true,
);
check(
  "and the $90 with an unreadable tag",
  run.unattributed.some((s) => s.netRevenueCents === 9_000),
  true,
);
check(
  "none of it reached anybody's pay",
  run.people.reduce((n, p) => n + p.commissionCents, 0),
  1800 + 1800 + 2000,
);

/* ------------------------------------------------------------- the totals */

check(
  "the total is hours plus commission",
  run.totals.totalCents,
  run.totals.hourlyPayCents + run.totals.commissionCents,
);
check("and matches the people", run.totals.totalCents, run.people.reduce((n, p) => n + p.totalCents, 0));

/* ------------------------------------------------- one person's own rate */

await prisma.user.update({
  where: { id: ana.id },
  data: { hourlyRateCents: 2500, commissionBps: 250 },
});
const withOwn = await getPayrollPeriod(period.start, period.end);
const anaOwn = withOwn.people.find((p) => p.name === "Ana Night");
check("her own hourly rate is used", anaOwn?.hourlyPayCents, 15_000); // 6h at $25
check("and her own commission", anaOwn?.commissionCents, 5000); // 2.5% of $2,000
check("nobody else moved", withOwn.people.find((p) => p.name === "Maya Day")?.totalCents, 12_600);

// Clearing it puts her back on the standard rate rather than on nothing.
await prisma.user.update({
  where: { id: ana.id },
  data: { hourlyRateCents: null, commissionBps: null },
});
const cleared = await getPayrollPeriod(period.start, period.end);
check(
  "clearing a personal rate restores the team's",
  cleared.people.find((p) => p.name === "Ana Night")?.hourlyPayCents,
  10_800,
);

/* --------------------------------------- a day uploaded twice must not double */

const second = await prisma.importBatch.create({
  data: {
    showDate: toDbDate(DAY),
    status: "OK",
    files: [],
    flags: [],
    watchCount: 0,
    boxCount: 0,
    droppedCount: 0,
  },
  select: { id: true },
});
const originals = await prisma.salesRecord.findMany({ where: { batchId: batch.id } });
await prisma.salesRecord.createMany({
  data: originals.map((row) => {
    const copy = { ...row } as Partial<typeof row>;
    delete copy.id;
    return { ...copy, batchId: second.id } as Omit<typeof row, "id">;
  }),
});

const after = await getPayrollPeriod(period.start, period.end);
check(
  "a re-uploaded day does not double anybody's commission",
  after.people.find((p) => p.name === "Maya Day")?.commissionCents,
  1800,
);
check("nor the total", after.totals.commissionCents, 1800 + 1800 + 2000);

/* -------------------------------------------- changing the rate moves the pay */

await prisma.settings.update({
  where: { id: "singleton" },
  data: { streamerCommissionBps: 200 },
});
const doubled = await getPayrollPeriod(period.start, period.end);
check(
  "doubling the commission doubles what it pays",
  doubled.people.find((p) => p.name === "Maya Day")?.commissionCents,
  3600,
);
check(
  "and leaves the hours where they were",
  doubled.people.find((p) => p.name === "Maya Day")?.hourlyPayCents,
  10_800,
);

/* ------------------------------------------------ nobody has a rate at all */

await prisma.settings.update({
  where: { id: "singleton" },
  data: { streamerHourlyCents: 0, shippingHourlyCents: 0, streamerCommissionBps: 100 },
});
const unpaid = await getPayrollPeriod(period.start, period.end);
check("somebody who worked with no rate is flagged", unpaid.totals.unrated, 4);
check(
  "and their hourly pay is honestly zero",
  unpaid.people.find((p) => p.name === "Pat Packer")?.totalCents,
  0,
);

/* ------------------------------------------------------------------ cleanup */

console.log("\nCleaning up.");
await prisma.settings.update({
  where: { id: "singleton" },
  data: {
    streamerHourlyCents: settingsBefore.streamerHourlyCents,
    shippingHourlyCents: settingsBefore.shippingHourlyCents,
    streamerCommissionBps: settingsBefore.streamerCommissionBps,
  },
});
await clearFixtures();
console.log(
  `Removed — ${await prisma.user.count({ where: { email: { endsWith: DOMAIN } } })} fixture accounts, ` +
    `${await prisma.importBatch.count({ where: { showDate: toDbDate(DAY) } })} fixture uploads left. ` +
    `Rates put back as they were.`,
);

await prisma.$disconnect();
console.log(failures === 0 ? "\nAll payroll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Payroll, against a real database.
 *
 * The unit tests cover the arithmetic. This covers the join, which is where the
 * money actually goes wrong: hours live on the timesheet, sales live in an
 * upload, and what connects them is the show a watch sold in — not the shift
 * tag on the listing, which says only which show it was prepared for. Getting
 * that backwards pays the wrong team, and every figure still looks plausible.
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
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { getPayrollPeriod } from "../src/lib/server/payroll";

assertDevDatabase("check-payroll.mts");

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
// Commission is paid from the show's own kind of business now, so the fixture
// has to set it where the app reads it — Settings holds only the fallback.
const watchRatesBefore = await prisma.businessSettings.findUniqueOrThrow({
  where: { business: "WATCH" },
});
const diamondRatesBefore = await prisma.businessSettings.findUniqueOrThrow({
  where: { business: "DIAMOND" },
});

await prisma.settings.update({
  where: { id: "singleton" },
  data: {
    streamerHourlyCents: 1800, // $18.00
    shippingHourlyCents: 1600, // $16.00
    streamerCommissionBps: 100, // 1%
  },
});
// The streamer hourly is per kind of show too, and read from here.
await prisma.businessSettings.update({
  where: { business: "WATCH" },
  data: { streamerCommissionBps: 100, streamerHourlyCents: 1800 }, // 1%, $18.00
});
await prisma.businessSettings.update({
  where: { business: "DIAMOND" },
  data: { streamerCommissionBps: 100, streamerHourlyCents: 2200 }, // 1%, $22.00
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
  business: "WATCH" | "DIAMOND" = "WATCH",
  status: "SCHEDULED" | "CANCELLED" = "SCHEDULED",
) {
  const startsAt = new Date(`${DAY}T${slot === "DAY" ? "17" : "23"}:00:00.000Z`);
  const endsAt = new Date(startsAt.getTime() + 6 * 3_600_000);
  const release = await prisma.release.create({
    data: {
      name: `${FIXTURE} ${business} ${platform} ${slot}`,
      business,
      startDate: toDbDate(DAY),
      endDate: toDbDate(DAY),
      status: "CLOSED",
      scheduleStatus: "PUBLISHED",
      shows: {
        create: {
          date: toDbDate(DAY),
          business,
          status,
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

// $1,000 on the day show and $2,000 on the night show.
await sale({ platform: "TIKTOK", show: "TikTok AM", shiftTag: `${TAG_DAY} AM`, cents: 100_000 });
await sale({ platform: "TIKTOK", show: "TikTok PM", shiftTag: `${TAG_DAY} PM`, cents: 200_000 });

/*
  $500 that SOLD during the night show but was LISTED for the day one.

  This is the real 09/08 case: eleven watches, $751, tagged AM and bought during
  the PM show. Whoever was live when the buyer paid earned it, so this belongs
  to the night pair — and the tag has nothing to do with pay.
*/
await sale({ platform: "TIKTOK", show: "TikTok PM", shiftTag: `${TAG_DAY} AM`, cents: 50_000 });

// $700 on an eBay show nobody is rostered on. Nobody can be paid it.
await sale({ platform: "EBAY", show: "eBay PM", shiftTag: `${TAG_DAY} PM`, cents: 70_000 });

// A gibberish tag changes nothing now: eBay reads the show off the tag and
// falls back to PM, and pay follows the show either way.
await sale({ platform: "TIKTOK", show: "TikTok PM", shiftTag: "who knows", cents: 9_000 });

console.log(`Built two shows and five sales on ${DAY}.\n`);

/* --------------------------------------------------------------- the hours */

async function hours(
  userId: string,
  showId: string | null,
  startsAt: Date,
  hoursWorked: number | null,
  source?: "SELF" | "ADMIN" | "SCHEDULE",
) {
  await prisma.timeEntry.create({
    data: {
      userId,
      showId,
      clockInAt: startsAt,
      // Null is somebody who never clocked out.
      clockOutAt:
        hoursWorked === null ? null : new Date(startsAt.getTime() + hoursWorked * 3_600_000),
      source: source ?? (showId ? "SCHEDULE" : "SELF"),
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

/* ------------------------- the day show: only the $1,000 that sold in it */

const daySales = 100_000; // $1,000
check(
  "a show earns what sold in it",
  run.shows.find((s) => s.key.slot === "DAY")?.netRevenueCents,
  daySales,
);
check("both people on the day show earn on it", by("Maya Day")?.shows.length, 1);
check("one per cent each", by("Maya Day")?.commissionCents, 1000);
check("and the same for the other one", by("Devon Day")?.commissionCents, 1000);

// 1% each, not 1% split: the show pays out 2% of its sales in total.
check(
  "the show pays out twice its rate in total",
  (by("Maya Day")?.commissionCents ?? 0) + (by("Devon Day")?.commissionCents ?? 0),
  Math.round(daySales * 0.02),
);

/* --- the night show: $2,000 + the $500 tagged AM + the $90 with no tag */

// The one that matters. Whoever was live when the buyer paid earned it, so the
// watch listed for the morning show and bought during the evening one is the
// evening pair's — the tag is not consulted.
const nightSales = 200_000 + 50_000 + 9_000; // $2,590
check(
  "a watch bought during the night show is the night pair's, whatever it was tagged",
  run.shows.find((s) => s.key.slot === "NIGHT")?.netRevenueCents,
  nightSales,
);
check("and they are paid on all of it", by("Ana Night")?.commissionCents, 2590);
check(
  "the day pair is not paid any of it",
  by("Maya Day")?.shows.some((s) => s.netRevenueCents === nightSales),
  false,
);

// Every penny sold lands on exactly one show. Nothing counted twice, nothing
// lost between them.
check(
  "every sale reaches exactly one show",
  run.shows.reduce((n, s) => n + s.netRevenueCents, 0) +
    run.unattributed.reduce((n, s) => n + s.netRevenueCents, 0),
  100_000 + 200_000 + 50_000 + 70_000 + 9_000,
);

/* ---------------------------------------------------------------- the hours */

check("six hours at $18", by("Maya Day")?.hourlyPayCents, 10_800);
check("plus commission", by("Maya Day")?.totalCents, 10_800 + 1000);
check("shipping is paid eight hours at $16", by("Pat Packer")?.hourlyPayCents, 12_800);
check("and earns no commission at all", by("Pat Packer")?.commissionCents, 0);
check("nor is credited with any show", by("Pat Packer")?.shows.length, 0);

/* ------------------------------------------------------------ what nobody earns */

check("sales for an unrostered show are reported", run.unattributed.length, 1);
check(
  "the $700 nobody is rostered for",
  run.unattributed[0]?.netRevenueCents,
  70_000,
);
check(
  "none of it reached anybody's pay",
  run.people.reduce((n, p) => n + p.commissionCents, 0),
  1000 + 1000 + 2590,
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
check("and her own commission", anaOwn?.commissionCents, 6475); // 2.5% of $2,590
check("nobody else moved", withOwn.people.find((p) => p.name === "Maya Day")?.totalCents, 11_800);

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
  1000,
);
check("nor the total", after.totals.commissionCents, 1000 + 1000 + 2590);

/* -------------------------------------------- changing the rate moves the pay */

// Set where the app reads it. Changing Settings alone no longer moves what is
// paid — that column is only the fallback for a business with no row — and this
// check is what caught that when the readers moved.
await prisma.businessSettings.update({
  where: { business: "WATCH" },
  data: { streamerCommissionBps: 200 },
});
const doubled = await getPayrollPeriod(period.start, period.end);
check(
  "doubling the commission doubles what it pays",
  doubled.people.find((p) => p.name === "Maya Day")?.commissionCents,
  2000,
);
check(
  "and leaves the hours where they were",
  doubled.people.find((p) => p.name === "Maya Day")?.hourlyPayCents,
  10_800,
);

/* ---------------------------- watch streamers and diamond streamers apart */

console.log("\nDiamond streamers on their own hourly.");
await prisma.businessSettings.update({
  where: { business: "WATCH" },
  data: { streamerCommissionBps: 100 },
});

const dina = await prisma.user.create({
  data: {
    name: "Dina Diamond",
    team: "STREAMING",
    role: "EMPLOYEE",
    email: `p9${DOMAIN}`,
    passwordHash: "x",
  },
  select: { id: true, name: true },
});
// A diamond TikTok Night on the same date as the watch TikTok Night — the
// same platform and slot, told apart only by the business.
const diamondNight = await makeShow("TIKTOK", "NIGHT", [dina, maya], "DIAMOND");
// A diamond eBay Day that was called off, with an hour an admin entered anyway.
const diamondCancelled = await makeShow("EBAY", "DAY", [dina], "DIAMOND", "CANCELLED");

const before = await getPayrollPeriod(period.start, period.end);
const devonBefore = before.people.find((p) => p.name === "Devon Day")?.totalCents;

await hours(dina.id, diamondNight.id, diamondNight.startsAt, 4);
await hours(maya.id, diamondNight.id, diamondNight.startsAt, 4);
await hours(dina.id, diamondCancelled.id, diamondCancelled.startsAt, 1, "ADMIN");
// Ana works two hours off the schedule: no show, so the watch rate.
await hours(ana.id, null, new Date(`${DAY}T12:00:00.000Z`), 2);

const split = await getPayrollPeriod(period.start, period.end);
const get = (name: string) => split.people.find((p) => p.name === name);

check("the diamond rate is read from its own row", split.rates.diamondStreamerHourlyCents, 2200);
check("the watch rate is read from its own row", split.rates.streamerHourlyCents, 1800);
check(
  "a diamond-only streamer is paid the diamond rate on every hour",
  get("Dina Diamond")?.hourly.map((l) => [l.business, l.rateCents]),
  [["DIAMOND", 2200]],
);
check(
  "including the hour on a cancelled diamond show",
  get("Dina Diamond")?.hourly[0]?.minutes,
  get("Dina Diamond")?.minutes,
);
check("which is five hours in all", get("Dina Diamond")?.minutes, 300);
check(
  "a streamer on both is paid each rate on its own hours",
  get("Maya Day")?.hourly.map((l) => [l.business, l.minutes, l.payCents]),
  [
    ["WATCH", 360, 10_800],
    ["DIAMOND", 240, 8800],
  ],
);
check("and her hourly pay is the two added", get("Maya Day")?.hourlyPayCents, 19_600);
check(
  "hours with no show are paid the watch rate",
  get("Ana Night")?.hourly.map((l) => [l.business, l.minutes, l.rateCents]),
  [["WATCH", 480, 1800]],
);
check("shipping still have one rate", get("Pat Packer")?.hourlyPayCents, 12_800);
check("a watch-only streamer did not move", get("Devon Day")?.totalCents, devonBefore);
check(
  "a diamond show sharing a watch show's slot does not pay the watch pair",
  get("Ana Night")?.shows.length,
  1,
);
check(
  "the totals are still the people added up",
  split.totals.hourlyPayCents,
  split.people.reduce((n, p) => n + p.hourlyPayCents, 0),
);

// A shift never clocked out is not paid, diamond or not.
await hours(
  dina.id,
  diamondNight.id,
  // Mid-afternoon in New York, so it is on the same day as the rest.
  new Date(`${DAY}T20:00:00.000Z`),
  null,
  "SELF",
);
const withOpen = await getPayrollPeriod(period.start, period.end);
check(
  "an open diamond shift adds nothing",
  withOpen.people.find((p) => p.name === "Dina Diamond")?.hourlyPayCents,
  get("Dina Diamond")?.hourlyPayCents,
);
check(
  "but is counted as open",
  withOpen.people.find((p) => p.name === "Dina Diamond")?.openShifts,
  1,
);

// Her own rate beats the diamond rate, as it beats the watch rate.
await prisma.user.update({ where: { id: dina.id }, data: { hourlyRateCents: 3000 } });
const dinaOwn = await getPayrollPeriod(period.start, period.end);
check(
  "a personal hourly beats the diamond rate",
  dinaOwn.people.find((p) => p.name === "Dina Diamond")?.hourlyPayCents,
  15_000, // 5h at $30
);
await prisma.user.update({ where: { id: dina.id }, data: { hourlyRateCents: null } });

// Raising the diamond rate moves diamond hours and nothing else.
await prisma.businessSettings.update({
  where: { business: "DIAMOND" },
  data: { streamerHourlyCents: 2500 },
});
const raised = await getPayrollPeriod(period.start, period.end);
check(
  "raising the diamond rate moves only diamond hours",
  raised.people.find((p) => p.name === "Maya Day")?.hourly.map((l) => l.payCents),
  [10_800, 10_000],
);
check(
  "and no watch-only streamer",
  raised.people.find((p) => p.name === "Devon Day")?.totalCents,
  devonBefore,
);

// Diamond rate never set: diamond hours are flagged even where watch hours were paid.
await prisma.businessSettings.update({
  where: { business: "DIAMOND" },
  data: { streamerHourlyCents: 0 },
});
const noDiamondRate = await getPayrollPeriod(period.start, period.end);
check(
  "a missing diamond rate flags everyone with diamond hours",
  noDiamondRate.people
    .filter((p) => p.unrated)
    .map((p) => p.name)
    .sort(),
  ["Dina Diamond", "Maya Day"],
);
check(
  "while their watch hours are still paid",
  noDiamondRate.people.find((p) => p.name === "Maya Day")?.hourlyPayCents,
  10_800,
);

/* ------------------------------------------------ nobody has a rate at all */

await prisma.settings.update({
  where: { id: "singleton" },
  data: { streamerHourlyCents: 0, shippingHourlyCents: 0, streamerCommissionBps: 100 },
});
await prisma.businessSettings.update({
  where: { business: "WATCH" },
  data: { streamerCommissionBps: 100, streamerHourlyCents: 0 },
});
const unpaid = await getPayrollPeriod(period.start, period.end);
check("somebody who worked with no rate is flagged", unpaid.totals.unrated, 5);
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
await prisma.businessSettings.update({
  where: { business: "WATCH" },
  data: {
    streamerCommissionBps: watchRatesBefore.streamerCommissionBps,
    streamerHourlyCents: watchRatesBefore.streamerHourlyCents,
  },
});
await prisma.businessSettings.update({
  where: { business: "DIAMOND" },
  data: {
    streamerCommissionBps: diamondRatesBefore.streamerCommissionBps,
    streamerHourlyCents: diamondRatesBefore.streamerHourlyCents,
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

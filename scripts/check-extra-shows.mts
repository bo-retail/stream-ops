/**
 * Extra shows in a release — an early morning TikTok — against a real database.
 *
 * The boss asked for a 7 AM to 1 PM TikTok show alongside the day and night
 * ones, and for a release to carry as many shows as he likes. What has to hold:
 *
 *   - what is already stored reads exactly as before (every slot DAY, NIGHT or none)
 *   - on a day with the early show, each TikTok file lands on its own show
 *   - the early show's file is its own line of the day's checklist
 *   - a corrected early-show file replaces only the early show's sales
 *   - the early show's pair are paid its commission, and nothing is unattributed
 *   - one export holding the morning and the day show: placed where most orders were, and warned about
 *   - a day with no early show: a morning-time file goes to the day show, as always
 *   - the early show cancelled: the same
 *   - availability offers the early show as its own choice
 *
 * Found by the review (10/14), each of which used to replace the early show's
 * file and sweep its unpacked boxes off the floor:
 *   - a day export whose stream went live at 12:20, before the 1 PM start
 *   - a morning file uploaded while the schedule was still a draft
 *   - the early show cancelled after its file was in, then that file corrected
 *   - the early show deleted from the release after its file was in, then corrected
 *   - a file mostly the night show's but placed on the day show: said out loud
 *   - two shows' files uploaded at the same moment onto one line: one refused
 *
 * Dates are years in the past and everything is removed at the end. It refuses
 * to run against anything but a local database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-extra-shows.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { tiktokReport } from "../src/lib/domain/imports/synthetic-exports";
import { runImport } from "../src/lib/server/imports";
import { listShowDays } from "../src/lib/server/shipping";
import { getPayrollPeriod } from "../src/lib/server/payroll";
import { getAvailabilityForRelease } from "../src/lib/server/availability";

assertDevDatabase("check-extra-shows.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

// Summer, Eastern daylight time: 7 AM Eastern is 11:00 UTC, 4 AM Pacific.
const EXTRA = "2021-07-06";
const BOTH_IN_ONE = "2021-07-08";
const PLAIN = "2021-07-10";
const CANCELLED = "2021-07-12";
const EARLY_LIVE = "2021-07-14";
const DRAFT = "2021-07-16";
const CALLED_OFF_AFTER = "2021-07-18";
const DELETED_AFTER = "2021-07-20";
const MOSTLY_NIGHT = "2021-07-22";
const AT_ONCE = "2021-07-24";
const ALL = [EXTRA, BOTH_IN_ONE, PLAIN, CANCELLED, EARLY_LIVE, DRAFT, CALLED_OFF_AFTER, DELETED_AFTER, MOSTLY_NIGHT, AT_ONCE];
const PREFIX = "check: extra shows ";

async function clean() {
  const days = { showDate: { in: ALL.map(toDbDate) } };
  await prisma.scanEvent.deleteMany({ where: { package: days } });
  await prisma.packageItem.deleteMany({ where: { package: days } });
  await prisma.package.deleteMany({ where: days });
  await prisma.importBatch.deleteMany({ where: days });
  await prisma.release.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

/* ------------------------------------------- what is already there, untouched */

await clean();
const [showSlots, availabilitySlots, batchSlots] = await Promise.all([
  prisma.show.groupBy({ by: ["slot"], _count: { _all: true } }),
  prisma.availability.groupBy({ by: ["slot"], _count: { _all: true } }),
  prisma.importBatch.groupBy({ by: ["slot"], _count: { _all: true } }),
]);
const odd = (rows: { slot: string | null }[]) =>
  rows.map((r) => r.slot).filter((s) => s !== "DAY" && s !== "NIGHT" && s !== null);
console.log(
  `stored: ${showSlots.map((r) => `${r.slot} ${r._count._all}`).join(", ")} shows; ` +
    `${availabilitySlots.reduce((n, r) => n + r._count._all, 0)} availability rows; ` +
    `${batchSlots.reduce((n, r) => n + r._count._all, 0)} uploads`,
);
check("every stored show is still DAY or NIGHT", odd(showSlots), []);
check("every stored availability answer is still DAY or NIGHT", odd(availabilitySlots), []);
check("every stored upload is still DAY, NIGHT or none", odd(batchSlots), []);

/* ------------------------------------------------------------------ fixtures */

const boss = await prisma.user.findFirstOrThrow({ where: { role: "BOSS", isActive: true }, select: { id: true } });
const streamers = await prisma.user.findMany({
  where: { isActive: true, team: "STREAMING" },
  select: { id: true, name: true },
  orderBy: { name: "asc" },
  take: 2,
});
if (streamers.length < 2) throw new Error("needs two active streamers in the development database");

const HOURS: Record<string, [string, string]> = {
  "EARLY AM": ["11:00", "17:00"],
  DAY: ["17:00", "23:00"],
  NIGHT: ["23:00", "05:00"],
};

/** A published watch release with these TikTok shows on a day; the early pair on the early show. */
async function schedule(day: string, shows: { slot: string; cancelled?: boolean }[], draft = false) {
  const release = await prisma.release.create({
    data: { name: `${PREFIX}${day}`, business: "WATCH", startDate: toDbDate(day), endDate: toDbDate(day), scheduleStatus: draft ? "DRAFT" : "PUBLISHED" },
    select: { id: true },
  });
  for (const s of shows) {
    const [start, end] = HOURS[s.slot];
    const startsAt = new Date(`${day}T${start}:00.000Z`);
    let endsAt = new Date(`${day}T${end}:00.000Z`);
    if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + 24 * 3600_000);
    const show = await prisma.show.create({
      data: {
        releaseId: release.id,
        business: "WATCH",
        date: toDbDate(day),
        platform: "TIKTOK",
        slot: s.slot,
        status: s.cancelled ? "CANCELLED" : "SCHEDULED",
        startsAt,
        endsAt,
      },
      select: { id: true },
    });
    if (s.slot === "EARLY AM") {
      await prisma.assignment.createMany({
        data: streamers.map((p, i) => ({ showId: show.id, userId: p.id, seat: i + 1 })),
      });
    }
  }
  return release.id;
}

/** A watch TikTok export of `n` orders placed at a Pacific `time`. */
const file = (name: string, day: string, n: number, base: string, time: string) => ({
  name,
  text: tiktokReport("vaultshowlive", day, n, base, { time }),
});

/** Two exports' rows in one file. */
function joined(name: string, a: { text: string }, b: { text: string }) {
  const [header, ...rowsA] = a.text.split("\n");
  const rowsB = b.text.split("\n").slice(1);
  return { name, text: [header, ...rowsA, ...rowsB].filter((l) => l.trim() !== "").join("\n") };
}

async function upload(files: { name: string; text: string }[]) {
  const outcome = await runImport(files, boss.id);
  if (outcome.status !== "OK") throw new Error(`upload refused: ${outcome.flags.map((f) => f.message).join(" | ")}`);
  return outcome;
}

/** The day's current sales, show by show. */
async function byShow(day: string) {
  const batches = await prisma.importBatch.findMany({
    where: { business: "WATCH", status: "OK", showDate: toDbDate(day) },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, platform: true, slot: true },
  });
  const ids = new Map<string, string>();
  for (const b of batches) if (!ids.has(`${b.platform}|${b.slot}`)) ids.set(`${b.platform}|${b.slot}`, b.id);
  const rows = await prisma.salesRecord.findMany({
    where: { batchId: { in: [...ids.values()] } },
    select: { show: true, batch: { select: { slot: true } } },
  });
  const out: Record<string, number> = {};
  for (const r of rows) out[`${r.show} @ ${r.batch.slot}`] = (out[`${r.show} @ ${r.batch.slot}`] ?? 0) + 1;
  // Sorted, so a check compares what is there and not the order it was read in.
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y)));
}

try {
  /* ------------------------------------------------- the ordinary early day */

  const releaseId = await schedule(EXTRA, [{ slot: "EARLY AM" }, { slot: "DAY" }, { slot: "NIGHT" }]);

  const morning = await upload([file("early.csv", EXTRA, 3, "77001", "04:10:00 AM")]);
  check(
    "the morning file is said to be the early show's",
    morning.flags.some((f) => f.severity === "info" && f.message.includes("EARLY AM")),
    true,
  );
  await upload([file("day.csv", EXTRA, 2, "77101", "10:17:29 AM")]);
  await upload([file("night.csv", EXTRA, 1, "77201", "04:40:00 PM")]);
  check("each file on its own show and its own line", await byShow(EXTRA), {
    "TikTok AM @ DAY": 2,
    "TikTok EARLY AM @ EARLY AM": 3,
    "TikTok PM @ NIGHT": 1,
  });

  const days = await listShowDays(4000);
  const today = days.find((d) => d.dateISO === EXTRA);
  check(
    "the checklist has the early show's line, first, and loaded",
    today?.checklist.map((l) => [l.label, l.loaded !== null]),
    [
      ["Watch TikTok EARLY AM", true],
      ["Watch TikTok Day", true],
      ["Watch TikTok Night", true],
    ],
  );
  check("nothing is missing on the day", today?.missing ?? null, null);

  // A corrected morning export, one order cancelled since: replaces the morning only.
  await upload([file("early-v2.csv", EXTRA, 2, "77001", "04:10:00 AM")]);
  check("a corrected early file replaces only the early show", await byShow(EXTRA), {
    "TikTok AM @ DAY": 2,
    "TikTok EARLY AM @ EARLY AM": 2,
    "TikTok PM @ NIGHT": 1,
  });
  // The same file again changes nothing.
  await upload([file("early-v2.csv", EXTRA, 2, "77001", "04:10:00 AM")]);
  check("the same file twice: nothing doubled", (await byShow(EXTRA))["TikTok EARLY AM @ EARLY AM"], 2);

  const pay = await getPayrollPeriod(EXTRA, EXTRA);
  const early = pay.shows.find((s) => s.key.slot === "EARLY AM");
  check("the early show is on the payroll with its two orders' takings", early?.netRevenueCents, 2 * 4100);
  check(
    "and its pair are the ones paid for it",
    early?.people.map((p) => p.name).sort(),
    streamers.map((p) => p.name).sort(),
  );
  check("no early-show sales are left unattributed", pay.unattributed.filter((s) => s.key.slot === "EARLY AM"), []);
  check(
    "the day show's sales were not credited to the early show",
    pay.shows.find((s) => s.key.slot === "DAY")?.netRevenueCents ?? pay.unattributed.find((s) => s.key.slot === "DAY")?.netRevenueCents,
    2 * 4100,
  );

  const offered = await getAvailabilityForRelease(streamers[0].id, releaseId);
  check(
    "availability offers the early show as its own choice, first",
    offered?.options.map((o) => [o.slot, o.startHM]),
    [
      ["EARLY AM", "07:00"],
      ["DAY", "13:00"],
      ["NIGHT", "19:00"],
    ],
  );

  /* ------------------------------------- two shows' orders in one export */

  await schedule(BOTH_IN_ONE, [{ slot: "EARLY AM" }, { slot: "DAY" }, { slot: "NIGHT" }]);
  const both = await upload([
    joined(
      "both.csv",
      file("", BOTH_IN_ONE, 2, "78001", "04:20:00 AM"),
      file("", BOTH_IN_ONE, 3, "78101", "12:30:00 PM"),
    ),
  ]);
  check("one export of two shows, two morning and three day orders: placed where most were", await byShow(BOTH_IN_ONE), {
    "TikTok AM @ DAY": 5,
  });
  check(
    "and the upload says two orders were placed during the early show",
    both.flags.some((f) => f.severity === "warning" && f.message.includes("2 order(s)") && f.message.includes("EARLY AM")),
    true,
  );

  /* -------------------------------------------- found by the review (10/14) */

  const boxes = (day: string) => prisma.package.count({ where: { showDate: toDbDate(day) } });

  await schedule(EARLY_LIVE, [{ slot: "EARLY AM" }, { slot: "DAY" }, { slot: "NIGHT" }]);
  await upload([file("early.csv", EARLY_LIVE, 3, "80001", "04:10:00 AM")]);
  // The day stream went live at 12:20 Eastern (9:20 Pacific): one order then, three after 1 PM.
  await upload([
    joined("day.csv", file("", EARLY_LIVE, 1, "80101", "09:20:00 AM"), file("", EARLY_LIVE, 3, "80201", "10:30:00 AM")),
  ]);
  check("a day export that went live at 12:20 is the day show's, and the early file is untouched", await byShow(EARLY_LIVE), {
    "TikTok AM @ DAY": 4,
    "TikTok EARLY AM @ EARLY AM": 3,
  });
  check("and every box from both files is still on the floor", await boxes(EARLY_LIVE), 7);

  await schedule(DRAFT, [{ slot: "EARLY AM" }, { slot: "DAY" }, { slot: "NIGHT" }], true);
  await upload([file("early.csv", DRAFT, 3, "81001", "04:10:00 AM")]);
  await upload([file("day.csv", DRAFT, 2, "81101", "10:17:29 AM")]);
  check("schedule still a draft: the morning file is still the early show's, the day file the day's", await byShow(DRAFT), {
    "TikTok AM @ DAY": 2,
    "TikTok EARLY AM @ EARLY AM": 3,
  });

  await schedule(CALLED_OFF_AFTER, [{ slot: "EARLY AM" }, { slot: "DAY" }, { slot: "NIGHT" }]);
  await upload([file("early.csv", CALLED_OFF_AFTER, 3, "82001", "04:10:00 AM")]);
  await upload([file("day.csv", CALLED_OFF_AFTER, 2, "82101", "10:17:29 AM")]);
  await prisma.show.updateMany({
    where: { date: toDbDate(CALLED_OFF_AFTER), slot: "EARLY AM" },
    data: { status: "CANCELLED" },
  });
  const corrected = await runImport([file("early-v2.csv", CALLED_OFF_AFTER, 2, "82001", "04:10:00 AM")], boss.id);
  check("early show called off, its file corrected: refused rather than replacing the day show's file", corrected.status, "BLOCKED");
  check(
    "and the refusal says the two files share no orders",
    corrected.flags.some((f) => f.severity === "blocking" && f.message.includes("share no orders")),
    true,
  );
  check("nothing was changed", await byShow(CALLED_OFF_AFTER), {
    "TikTok AM @ DAY": 2,
    "TikTok EARLY AM @ EARLY AM": 3,
  });
  check("no box was swept away", await boxes(CALLED_OFF_AFTER), 5);
  // The day file corrected on the same day is still a correction, and goes in.
  await upload([file("day-v2.csv", CALLED_OFF_AFTER, 1, "82101", "10:17:29 AM")]);
  check("while a real correction of the day file still goes in", (await byShow(CALLED_OFF_AFTER))["TikTok AM @ DAY"], 1);

  await schedule(DELETED_AFTER, [{ slot: "EARLY AM" }, { slot: "DAY" }, { slot: "NIGHT" }]);
  await upload([file("early.csv", DELETED_AFTER, 3, "83001", "04:10:00 AM")]);
  await upload([file("day.csv", DELETED_AFTER, 2, "83101", "10:17:29 AM")]);
  await prisma.assignment.deleteMany({ where: { show: { date: toDbDate(DELETED_AFTER), slot: "EARLY AM" } } });
  await prisma.show.deleteMany({ where: { date: toDbDate(DELETED_AFTER), slot: "EARLY AM" } });
  const afterDelete = await runImport([file("early-v2.csv", DELETED_AFTER, 2, "83001", "04:10:00 AM")], boss.id);
  check("early show deleted, its file corrected: still refused rather than replacing the day file", afterDelete.status, "BLOCKED");
  check("the day show's file and boxes untouched", [await byShow(DELETED_AFTER), await boxes(DELETED_AFTER)], [
    { "TikTok AM @ DAY": 2, "TikTok EARLY AM @ EARLY AM": 3 },
    5,
  ]);

  await schedule(MOSTLY_NIGHT, [{ slot: "EARLY AM" }, { slot: "DAY" }, { slot: "NIGHT" }]);
  // One order at 6 PM Eastern, five at 8 PM: the parse puts it on the day show by its first order.
  const night = await upload([
    joined("late.csv", file("", MOSTLY_NIGHT, 1, "84001", "03:00:00 PM"), file("", MOSTLY_NIGHT, 5, "84101", "05:00:00 PM")),
  ]);
  check("a file mostly the night show's stays where the parse put it", await byShow(MOSTLY_NIGHT), { "TikTok AM @ DAY": 6 });
  check(
    "and the upload says five of its orders were during the night show",
    night.flags.some((f) => f.severity === "warning" && f.message.includes("5 order(s)") && f.message.includes("Night")),
    true,
  );

  await schedule(AT_ONCE, [{ slot: "EARLY AM" }, { slot: "DAY" }, { slot: "NIGHT" }]);
  // Two people at once: the morning export, and a day export whose orders all came before 1 PM.
  const [one, two] = await Promise.all([
    runImport([file("early.csv", AT_ONCE, 3, "85001", "04:10:00 AM")], boss.id),
    runImport([file("day-early.csv", AT_ONCE, 2, "85101", "09:30:00 AM")], boss.id),
  ]);
  check("two files for one line at the same moment: one goes in, one is refused", [one.status, two.status].sort(), ["BLOCKED", "OK"]);
  const kept = await byShow(AT_ONCE);
  check(
    "and the line holds the one that went in, whole",
    Object.values(kept),
    [one.status === "OK" ? 3 : 2],
  );

  /* ------------------------------------------------- days without the early show */

  await schedule(PLAIN, [{ slot: "DAY" }, { slot: "NIGHT" }]);
  const plain = await upload([file("morning.csv", PLAIN, 2, "79001", "04:10:00 AM")]);
  check("no early show: a morning-time file is the day show's, as always", await byShow(PLAIN), {
    "TikTok AM @ DAY": 2,
  });
  check("and nothing is said about extra shows", plain.flags.some((f) => f.message.includes("first order at")), false);

  await schedule(CANCELLED, [{ slot: "EARLY AM", cancelled: true }, { slot: "DAY" }, { slot: "NIGHT" }]);
  await upload([file("morning.csv", CANCELLED, 2, "79101", "04:10:00 AM")]);
  check("the early show called off: the same as a day without it", await byShow(CANCELLED), {
    "TikTok AM @ DAY": 2,
  });
} finally {
  await clean();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * One watch TikTok export for a continuous stream — against a real database.
 *
 * 10/22: the boss may run the watch TikTok as one stream, 7 AM to 1 AM, while
 * the schedule keeps its early (7–1), day (1–7) and night (7–1) shows, each
 * with its own pair. TikTok then gives one export for the whole stream. It is
 * shared out by when each order was placed, so each pair is paid on what sold
 * while they were on. Not every day will be like that — some are stop and go —
 * and separate files, one per show, must keep working exactly as before.
 *
 * The situations:
 *   - the whole stream in one file: each order on its show, to the minute;
 *     after midnight still the night's; commission to the right pair; the
 *     checklist sees all three shows; one buyer across shows gets one box
 *   - the stream's file corrected (an order cancelled, a watch re-pinned)
 *     after shipping packed some of it; the same file uploaded twice
 *   - the show hours changed on the schedule, then the file uploaded again
 *   - one file per show, as today: an early file running a little over; the
 *     three uploaded together with one stray order deep in the next show
 *   - a day show that ran two hours over, uploaded before the night's file
 *   - the stream's file uploaded together with another show's file
 *   - a show's own file already in, then a stream file without its orders;
 *     and the two uploaded at the same moment
 *   - stop and go: the early show its own file and the day and night one
 *     stream (and that stream went live at 12:40; and the two files hold the
 *     same 12:40 orders); the early and day one stream and the night its own
 *   - the day show called off; the stream stopped for two hours; a day with
 *     only the day and night shows
 *
 * Every file is synthetic and every date years in the past. It refuses to run
 * against anything but a local database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-watch-stream.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { tiktokReport } from "../src/lib/domain/imports/synthetic-exports";
import { runImport } from "../src/lib/server/imports";
import { getBoxById, openBoxByScan, packItem } from "../src/lib/server/packing";
import { getPayrollPeriod } from "../src/lib/server/payroll";
import { latestBatches } from "../src/lib/server/sales-data";

assertDevDatabase("check-watch-stream.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

// Summer, Eastern daylight time. TikTok's times are Pacific: 4 AM Pacific is 7 AM Eastern.
const STREAM = "2021-07-05";
const SEPARATE = "2021-07-07";
const TOGETHER = "2021-07-09";
const OWN_FILE = "2021-07-11";
const CALLED_OFF = "2021-07-13";
const GAP = "2021-07-15";
const TWO_SHOWS = "2021-07-17";
const MIXED = "2021-07-19";
const MIXED_EARLY = "2021-07-21";
const MIXED_NIGHT = "2021-07-23";
const STRAY = "2021-07-25";
const OVERRUN = "2021-07-27";
const OVERLAP = "2021-07-29";
const RACE = "2021-07-31";
const WITH_EARLY = "2021-08-02";
const EARLY_FIRST = "2021-08-04";
const QUIET = "2021-08-06";
const UNREADABLE = "2021-08-08";
const SHORTER = "2021-08-10";
const EARLY_AFTER = "2021-08-12";
const ALL = [
  STREAM, SEPARATE, TOGETHER, OWN_FILE, CALLED_OFF, GAP, TWO_SHOWS,
  MIXED, MIXED_EARLY, MIXED_NIGHT, STRAY, OVERRUN, OVERLAP, RACE, WITH_EARLY, EARLY_FIRST, QUIET, UNREADABLE,
  SHORTER, EARLY_AFTER,
];
const FIXTURE = "check: watch stream ";
const DOMAIN = "@check-watch-stream.test";

async function clean() {
  const days = { showDate: { in: ALL.map(toDbDate) } };
  await prisma.scanEvent.deleteMany({ where: { package: days } });
  await prisma.packageItem.deleteMany({ where: { package: days } });
  await prisma.package.deleteMany({ where: days });
  await prisma.importBatch.deleteMany({ where: days });
  await prisma.release.deleteMany({ where: { name: { startsWith: FIXTURE } } });
  const users = await prisma.user.findMany({ where: { email: { endsWith: DOMAIN } }, select: { id: true } });
  if (users.length > 0) {
    const ids = users.map((u) => u.id);
    await prisma.timeEntryRevision.deleteMany({ where: { timeEntry: { userId: { in: ids } } } });
    await prisma.timeEntry.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

const [boss] = await prisma.user.findMany({
  where: { isActive: true },
  select: { id: true },
  orderBy: [{ role: "asc" }, { id: "asc" }],
  take: 1,
});

// Eastern hours as UTC (EDT is UTC-4).
const HOURS: Record<string, [number, number]> = { "EARLY AM": [11, 17], DAY: [17, 23], NIGHT: [23, 29] };

async function schedule(day: string, slots: string[], cast: Record<string, { id: string }[]> = {}, cancelled: string[] = []) {
  const base = new Date(`${day}T00:00:00.000Z`).getTime();
  await prisma.release.create({
    data: {
      name: `${FIXTURE}${day}`,
      business: "WATCH",
      startDate: toDbDate(day),
      endDate: toDbDate(day),
      scheduleStatus: "PUBLISHED",
      shows: {
        create: slots.map((slot) => {
          const [from, to] = HOURS[slot];
          return {
            business: "WATCH" as const,
            date: toDbDate(day),
            platform: "TIKTOK" as const,
            slot,
            status: cancelled.includes(slot) ? ("CANCELLED" as const) : ("SCHEDULED" as const),
            startsAt: new Date(base + from * 3_600_000),
            endsAt: new Date(base + to * 3_600_000),
            assignments: { create: (cast[slot] ?? []).map((p, i) => ({ userId: p.id, seat: i + 1 })) },
          };
        }),
      },
    },
  });
}

interface Part {
  time: string; // Pacific, "04:05:00 AM"
  n: number;
  base: string; // order-id base, unique per part
  names?: string[];
  tracking?: string | (string | undefined)[];
  buyer?: string;
  cancel?: boolean;
}
/** One TikTok export made of parts placed at different times of the day. */
function exportOf(name: string, day: string, parts: Part[]) {
  const texts = parts.map((p) => {
    const text = tiktokReport("vaultshowlive", day, p.n, p.base, { time: p.time, names: p.names, tracking: p.tracking, buyer: p.buyer });
    return p.cancel ? text.replaceAll(",To ship,", ",Canceled,") : text;
  });
  const [first, ...rest] = texts;
  return { name, text: [first, ...rest.map((t) => t.split("\r\n").slice(1).join("\r\n"))].join("\r\n") };
}

async function upload(...files: { name: string; text: string }[]) {
  return runImport(files, boss.id);
}
async function mustUpload(...files: { name: string; text: string }[]) {
  const outcome = await upload(...files);
  if (outcome.status !== "OK") throw new Error(`upload refused: ${outcome.flags.map((f) => f.message).join(" | ")}`);
  return outcome;
}
const says = (outcome: { flags: { message: string }[] }, text: string) => outcome.flags.some((f) => f.message.includes(text));

/** What the day reads now, show by show: pieces on each. */
async function bySlot(day: string) {
  const batches = await latestBatches(day, day);
  const out: Record<string, number> = {};
  for (const b of batches.filter((b) => b.platform === "TIKTOK").sort((a, b) => (a.slot ?? "").localeCompare(b.slot ?? ""))) {
    out[b.slot ?? "?"] = await prisma.salesRecord.count({ where: { batchId: b.id } });
  }
  return out;
}
/** Every order the day counts, with how many shows count it. */
async function countedTwice(day: string) {
  const ids = (await latestBatches(day, day)).map((b) => b.id);
  const rows = await prisma.salesRecord.groupBy({ by: ["lineRef"], where: { batchId: { in: ids } }, _count: true });
  return rows.filter((r) => r._count > 1).length;
}

async function boxOf(tracking: string) {
  const row = await prisma.package.findUniqueOrThrow({ where: { trackingNumber: tracking }, select: { id: true } });
  return (await getBoxById(row.id))!;
}
const contents = async (tracking: string) => (await boxOf(tracking)).items.map((i) => `${i.stockNumber} ${i.scanned}/${i.expected}`);
const label = (n: number) => `9234690377${String(n).padStart(12, "0")}`;

await clean();

try {
  const people = await Promise.all(
    ["Early One", "Early Two", "Day One", "Day Two", "Night One", "Night Two"].map((name, i) =>
      prisma.user.create({
        data: { name, team: "STREAMING", role: "EMPLOYEE", email: `s${i}${DOMAIN}`, passwordHash: "x" },
        select: { id: true, name: true },
      }),
    ),
  );
  const [e1, e2, d1, d2, n1, n2] = people;

  /* ------------------------------------------------- the whole stream, one file */

  console.log("One export for the stream, 7 AM to 1 AM Eastern, over three shows with their pairs.");
  await schedule(STREAM, ["EARLY AM", "DAY", "NIGHT"], { "EARLY AM": [e1, e2], DAY: [d1, d2], NIGHT: [n1, n2] });
  const JOE = label(1);
  const stream = (corrected = false) =>
    exportOf(corrected ? "stream corrected.csv" : "stream.csv", STREAM, [
      { time: "04:05:00 AM", n: 2, base: "91000001", names: [corrected ? "E1-RIGHT" : "E1", "E2"], tracking: [JOE, undefined], buyer: "joe" }, // 7:05 AM ET
      { time: "06:00:00 AM", n: 5, base: "91000009", names: ["E4", "E5", "E6", "E7", "E8"] }, // 9 AM ET
      { time: "09:59:00 AM", n: 1, base: "91000002", names: ["E3"] }, // 12:59 PM ET: early
      { time: "10:00:00 AM", n: 1, base: "91000003", names: ["D1"] }, // 1:00 PM ET: day
      { time: "12:00:00 PM", n: 3, base: "91000010", names: ["D5", "D6", "D7"] }, // 3 PM ET
      { time: "01:30:00 PM", n: 2, base: "91000004", names: ["D2", "D3"] }, // 4:30 PM ET
      { time: "03:59:00 PM", n: 1, base: "91000005", names: ["D4"] }, // 6:59 PM ET: day
      { time: "04:00:00 PM", n: 1, base: "91000006", names: ["N1"], tracking: JOE, buyer: "joe" }, // 7:00 PM ET: night
      { time: "06:00:00 PM", n: 3, base: "91000011", names: ["N4", "N5", "N6"] }, // 9 PM ET
      { time: "07:00:00 PM", n: 1, base: "91000007", names: ["N2"], cancel: corrected }, // 10 PM ET
      { time: "09:45:00 PM", n: 1, base: "91000008", names: ["N3"] }, // 12:45 AM ET, next day
    ]);
  const first = await mustUpload(stream());
  check("each order on the show that was on: 8 early, 7 day, 6 night", await bySlot(STREAM), { DAY: 7, "EARLY AM": 8, NIGHT: 6 });
  check("the upload says it was shared out", says(first, "shared out by when each order was placed"), true);
  check("no 'export each show on its own' warning", says(first, "export each show on its own"), false);
  check(
    "the checklist sees all three shows uploaded",
    (await latestBatches(STREAM, STREAM)).map((b) => b.slot).sort(),
    ["DAY", "EARLY AM", "NIGHT"],
  );
  check("one buyer across the early and night shows: one box with both", await contents(JOE), ["E1 0/1", "N1 0/1"]);

  const pay = await getPayrollPeriod(STREAM, STREAM);
  const shows = pay.shows
    .filter((s) => s.key.dateISO === STREAM && s.key.platform === "TIKTOK")
    .map((s) => `${s.key.slot}: ${s.netRevenueCents / 100} → ${s.people.map((p) => p.name).sort().join(", ")}`)
    .sort();
  check("commission: each show's takings to its own pair", shows, [
    "DAY: 287 → Day One, Day Two",
    "EARLY AM: 328 → Early One, Early Two",
    "NIGHT: 246 → Night One, Night Two",
  ]);
  check("nothing unpaid", pay.unattributed.filter((s) => s.key.dateISO === STREAM).length, 0);

  console.log("\nShipping packs joe's box (early and night pieces); then the stream file is corrected.");
  const joe = await boxOf(JOE);
  await openBoxByScan(boss.id, JOE);
  await packItem(boss.id, joe.id, "E1");
  await packItem(boss.id, joe.id, "N1");
  const OTHER = (
    await prisma.package.findFirstOrThrow({
      where: { showDate: toDbDate(STREAM), items: { some: { stockNumber: "D1" } } },
      select: { trackingNumber: true },
    })
  ).trackingNumber;

  const fixed = await mustUpload(stream(true));
  check("corrected: N2 cancelled off the night, nothing counted twice", await bySlot(STREAM), { DAY: 7, "EARLY AM": 8, NIGHT: 5 });
  check("joe's packed box is not changed, and the upload names it", [(await boxOf(JOE)).status, says(fixed, JOE)], ["CLOSED_COMPLETE", true]);
  check("an unpacked box from the day show is still there", await contents(OTHER), ["D1 0/1"]);

  console.log("The corrected file uploaded again, unchanged.");
  await mustUpload(stream(true));
  check("nothing changes", await bySlot(STREAM), { DAY: 7, "EARLY AM": 8, NIGHT: 5 });

  console.log("The night show moved to start at 8 PM on the schedule; the file uploaded again.");
  await prisma.show.updateMany({
    where: { date: toDbDate(STREAM), platform: "TIKTOK", slot: "NIGHT", release: { name: { startsWith: FIXTURE } } },
    data: { startsAt: new Date(Date.parse(`${STREAM}T00:00:00.000Z`) + 24 * 3_600_000) }, // 8 PM ET
  });
  await prisma.show.updateMany({
    where: { date: toDbDate(STREAM), platform: "TIKTOK", slot: "DAY", release: { name: { startsWith: FIXTURE } } },
    data: { endsAt: new Date(Date.parse(`${STREAM}T00:00:00.000Z`) + 24 * 3_600_000) },
  });
  await mustUpload(stream(true));
  check("the 7:00 PM order moves to the day, nothing counted twice", [await bySlot(STREAM), await countedTwice(STREAM)], [
    { DAY: 8, "EARLY AM": 8, NIGHT: 4 },
    0,
  ]);

  /* ---------------------------------------------------------- one file per show */

  console.log("\nOne file per show, as today; the early show ran 20 minutes over.");
  await schedule(SEPARATE, ["EARLY AM", "DAY", "NIGHT"]);
  const early = await mustUpload(
    exportOf("early.csv", SEPARATE, [
      { time: "04:00:00 AM", n: 4, base: "92000001" },
      { time: "10:20:00 AM", n: 1, base: "92000002" }, // 1:20 PM ET
    ]),
  );
  await mustUpload(exportOf("day.csv", SEPARATE, [{ time: "11:00:00 AM", n: 3, base: "92000003" }]));
  await mustUpload(exportOf("night.csv", SEPARATE, [{ time: "05:00:00 PM", n: 2, base: "92000004" }]));
  check("each file whole on its own show", await bySlot(SEPARATE), { DAY: 3, "EARLY AM": 5, NIGHT: 2 });
  check("the early file was not shared out", says(early, "shared out"), false);

  console.log("\nThe three shows' own files uploaded together; the day file has one order deep in the night.");
  await schedule(STRAY, ["EARLY AM", "DAY", "NIGHT"]);
  const morning = await upload(
    exportOf("early.csv", STRAY, [{ time: "05:00:00 AM", n: 4, base: "92100001" }]),
    exportOf("day.csv", STRAY, [
      { time: "11:00:00 AM", n: 5, base: "92100002" },
      { time: "06:10:00 PM", n: 1, base: "92100003" }, // 9:10 PM ET
    ]),
    exportOf("night.csv", STRAY, [{ time: "05:00:00 PM", n: 4, base: "92100004" }]),
  );
  check("accepted, each file whole on its own show", [morning.status, await bySlot(STRAY)], ["OK", { DAY: 6, "EARLY AM": 4, NIGHT: 4 }]);
  check("nothing shared out", says(morning, "shared out by when"), false);

  console.log("\nA day show that ran two hours over, uploaded before the night show's own file.");
  await schedule(OVERRUN, ["DAY", "NIGHT"]);
  const dayFile = exportOf("day.csv", OVERRUN, [
    { time: "11:00:00 AM", n: 5, base: "92200001" },
    { time: "05:30:00 PM", n: 5, base: "92200002" }, // 8:30 PM ET
  ]);
  const nightFile = exportOf("night.csv", OVERRUN, [{ time: "06:30:00 PM", n: 4, base: "92200003" }]);
  await mustUpload(dayFile);
  check("its late orders go to the night show for now", await bySlot(OVERRUN), { DAY: 5, NIGHT: 5 });
  const nightAlone = await upload(nightFile);
  check(
    "the night's own file alone is refused (it would drop those 5), and says to upload both together",
    [nightAlone.status, says(nightAlone, "together"), await bySlot(OVERRUN)],
    ["BLOCKED", true, { DAY: 5, NIGHT: 5 }],
  );
  const bothFiles = await upload(dayFile, nightFile);
  check(
    "both together: the day file whole on the day, the night's on the night, nothing lost or doubled",
    [bothFiles.status, await bySlot(OVERRUN), await countedTwice(OVERRUN)],
    ["OK", { DAY: 10, NIGHT: 4 }, 0],
  );

  /* --------------------------------------- the stream beside another show's file */

  console.log("\nThe stream's file (early and day) uploaded together with the night show's own file.");
  await schedule(TOGETHER, ["EARLY AM", "DAY", "NIGHT"]);
  const both = await upload(
    exportOf("stream.csv", TOGETHER, [
      { time: "05:00:00 AM", n: 5, base: "93000001" },
      { time: "12:00:00 PM", n: 5, base: "93000002" },
    ]),
    exportOf("night.csv", TOGETHER, [{ time: "05:00:00 PM", n: 2, base: "93000003" }]),
  );
  check("accepted: the stream shared between early and day, the night file on the night", [both.status, await bySlot(TOGETHER)], [
    "OK",
    { DAY: 5, "EARLY AM": 5, NIGHT: 2 },
  ]);

  /* ----------------------------- a show's own file in, then a stream without it */

  console.log("\nThe night show's own file is in; then a stream file that runs deep into the night without its orders.");
  await schedule(OWN_FILE, ["EARLY AM", "DAY", "NIGHT"]);
  await mustUpload(exportOf("night.csv", OWN_FILE, [{ time: "05:00:00 PM", n: 2, base: "94000001" }]));
  const notShared = await upload(
    exportOf("day-ish.csv", OWN_FILE, [
      { time: "05:00:00 AM", n: 5, base: "94000002" },
      { time: "12:00:00 PM", n: 5, base: "94000003" },
      { time: "06:00:00 PM", n: 5, base: "94000004" },
    ]),
  );
  check("the night show's file is untouched", (await bySlot(OWN_FILE)).NIGHT, 2);
  check("not shared out, and said why", says(notShared, "was not shared out"), true);

  console.log("\nThe night show's own file and a stream file without its orders, uploaded at the same moment.");
  await schedule(RACE, ["EARLY AM", "DAY", "NIGHT"]);
  const raced = await Promise.all([
    upload(exportOf("night.csv", RACE, [{ time: "05:00:00 PM", n: 2, base: "94100001" }])),
    upload(
      exportOf("stream.csv", RACE, [
        { time: "05:00:00 AM", n: 5, base: "94100002" },
        { time: "12:00:00 PM", n: 5, base: "94100003" },
        { time: "06:00:00 PM", n: 5, base: "94100004" },
      ]),
    ),
  ]);
  const raceDay = await bySlot(RACE);
  console.log(`   night file ${raced[0].status}, stream ${raced[1].status}; day reads ${JSON.stringify(raceDay)}`);
  check(
    "whichever landed first, the night file's 2 orders are never taken away by the stream",
    raced[0].status !== "OK" || (raceDay.NIGHT ?? 0) >= 2,
    true,
  );
  check("nothing counted twice", await countedTwice(RACE), 0);

  /* ------------------------------------------------- stop and go, mixed days */

  console.log("\nStop and go: the early show its own file, then one file for the day and night together.");
  await schedule(MIXED, ["EARLY AM", "DAY", "NIGHT"]);
  await mustUpload(exportOf("early.csv", MIXED, [{ time: "05:00:00 AM", n: 3, base: "98000001" }]));
  const dayNight = await mustUpload(
    exportOf("day and night.csv", MIXED, [
      { time: "11:00:00 AM", n: 5, base: "98000002" }, // 2 PM ET
      { time: "06:00:00 PM", n: 5, base: "98000003" }, // 9 PM ET
    ]),
  );
  check("early 3 (its own file), day 5, night 5", await bySlot(MIXED), { DAY: 5, "EARLY AM": 3, NIGHT: 5 });
  check("the day-and-night file was shared out", says(dayNight, "shared out by when"), true);

  console.log("The same, but that stream went live at 12:40 PM, before the day show.");
  await schedule(MIXED_EARLY, ["EARLY AM", "DAY", "NIGHT"]);
  await mustUpload(exportOf("early.csv", MIXED_EARLY, [{ time: "05:00:00 AM", n: 3, base: "99000001" }]));
  const wentLiveEarly = await upload(
    exportOf("day and night.csv", MIXED_EARLY, [
      { time: "09:40:00 AM", n: 1, base: "99000002" }, // 12:40 PM ET
      { time: "11:00:00 AM", n: 5, base: "99000003" },
      { time: "06:00:00 PM", n: 5, base: "99000004" },
    ]),
  );
  check(
    "still shared out: the early show keeps its own file, the 12:40 order goes to the day, the night gets its 5",
    [wentLiveEarly.status, await bySlot(MIXED_EARLY)],
    ["OK", { DAY: 6, "EARLY AM": 3, NIGHT: 5 }],
  );

  console.log("The early show's file and the day-and-night stream both hold the same 12:40 orders.");
  await schedule(OVERLAP, ["EARLY AM", "DAY", "NIGHT"]);
  await mustUpload(
    exportOf("early.csv", OVERLAP, [
      { time: "05:00:00 AM", n: 3, base: "99200001" },
      { time: "09:40:00 AM", n: 2, base: "99200002" }, // 12:40 PM ET, in both files
    ]),
  );
  const overlapping = await mustUpload(
    exportOf("day and night.csv", OVERLAP, [
      { time: "09:40:00 AM", n: 2, base: "99200002" },
      { time: "11:00:00 AM", n: 5, base: "99200003" },
      { time: "06:00:00 PM", n: 5, base: "99200004" },
    ]),
  );
  check(
    "the 12:40 orders stay on the early show, once; day 5, night 5",
    [await bySlot(OVERLAP), await countedTwice(OVERLAP), says(overlapping, "not counted again")],
    [{ DAY: 5, "EARLY AM": 5, NIGHT: 5 }, 0, true],
  );

  console.log("\nStop and go: one file for the early and day shows, the night show its own file.");
  await schedule(MIXED_NIGHT, ["EARLY AM", "DAY", "NIGHT"]);
  await mustUpload(
    exportOf("early and day.csv", MIXED_NIGHT, [
      { time: "05:00:00 AM", n: 5, base: "99100001" },
      { time: "12:00:00 PM", n: 5, base: "99100002" },
    ]),
  );
  await mustUpload(exportOf("night.csv", MIXED_NIGHT, [{ time: "05:00:00 PM", n: 2, base: "99100003" }]));
  check("early 5, day 5, night 2", await bySlot(MIXED_NIGHT), { DAY: 5, "EARLY AM": 5, NIGHT: 2 });

  /* ------------------------------- the early show's own file and the whole day */

  const earlyPart = { time: "05:00:00 AM", n: 5 };
  const wholeDay = (day: string, base: string) =>
    exportOf("whole day.csv", day, [
      { ...earlyPart, base: base + "1" },
      { time: "11:00:00 AM", n: 5, base: base + "2" },
      { time: "06:00:00 PM", n: 5, base: base + "3" },
    ]);
  console.log("\nThe early show's own file and the whole day's stream (which has the same early orders), together.");
  await schedule(WITH_EARLY, ["EARLY AM", "DAY", "NIGHT"]);
  const withEarly = await upload(exportOf("early.csv", WITH_EARLY, [{ ...earlyPart, base: "9940001" }]), wholeDay(WITH_EARLY, "994000"));
  for (const f of withEarly.flags) console.log(`   upload says [${f.severity}]: ${f.message}`);
  check(
    "accepted: early 5 once, day 5, night 5, nothing counted twice",
    [withEarly.status, await bySlot(WITH_EARLY), await countedTwice(WITH_EARLY)],
    ["OK", { DAY: 5, "EARLY AM": 5, NIGHT: 5 }, 0],
  );

  console.log("The same, the early file first and the whole day after.");
  await schedule(EARLY_FIRST, ["EARLY AM", "DAY", "NIGHT"]);
  await mustUpload(exportOf("early.csv", EARLY_FIRST, [{ ...earlyPart, base: "9950001" }]));
  await mustUpload(wholeDay(EARLY_FIRST, "995000"));
  check("early 5 once, day 5, night 5", [await bySlot(EARLY_FIRST), await countedTwice(EARLY_FIRST)], [{ DAY: 5, "EARLY AM": 5, NIGHT: 5 }, 0]);

  console.log("\nA stream whose early and night shows sold little: 5 early, 40 day, 5 night.");
  await schedule(QUIET, ["EARLY AM", "DAY", "NIGHT"]);
  await mustUpload(
    exportOf("stream.csv", QUIET, [
      { time: "05:00:00 AM", n: 5, base: "99600001" },
      { time: "11:00:00 AM", n: 40, base: "99600002" },
      { time: "06:00:00 PM", n: 5, base: "99600003" },
    ]),
  );
  check("shared out: each show its own", await bySlot(QUIET), { DAY: 40, "EARLY AM": 5, NIGHT: 5 });

  console.log("\nA stream with one Created Time Excel has damaged.");
  await schedule(UNREADABLE, ["EARLY AM", "DAY", "NIGHT"]);
  const good = exportOf("stream.csv", UNREADABLE, [
    { time: "05:00:00 AM", n: 5, base: "99700001" },
    { time: "11:00:00 AM", n: 6, base: "99700002" },
  ]);
  const damaged = await upload({ name: good.name, text: good.text.replace("08/08/2021 11:00:00 AM", "2021-08-08 11:00") });
  check("refused, with why", [damaged.status, says(damaged, "no readable Created"), await bySlot(UNREADABLE)], ["BLOCKED", true, {}]);

  console.log("\nThe stream corrected (a night order cancelled) by an export ending a few minutes earlier, one order short.");
  await schedule(SHORTER, ["EARLY AM", "DAY", "NIGHT"]);
  const full = (cancelLast: boolean, short: boolean) =>
    exportOf("stream.csv", SHORTER, [
      { time: "05:00:00 AM", n: 5, base: "99800001" },
      { time: "11:00:00 AM", n: 5, base: "99800002" },
      { time: "06:00:00 PM", n: 5, base: "99800003" },
      { time: "08:00:00 PM", n: 1, base: "99800004", cancel: cancelLast },
      ...(short ? [] : [{ time: "09:58:00 PM", n: 1, base: "99800005" }]), // 12:58 AM ET
    ]);
  await mustUpload(full(false, false));
  check("first upload: early 5, day 5, night 7", await bySlot(SHORTER), { DAY: 5, "EARLY AM": 5, NIGHT: 7 });
  const short = await upload(full(true, true));
  check(
    "the short correction is refused, naming what it lacks, and nothing changes",
    [short.status, says(short, "does not have 1 order"), await bySlot(SHORTER)],
    ["BLOCKED", true, { DAY: 5, "EARLY AM": 5, NIGHT: 7 }],
  );
  await mustUpload(full(true, false));
  check("the whole stream re-exported: the cancelled order comes off the night", await bySlot(SHORTER), { DAY: 5, "EARLY AM": 5, NIGHT: 6 });

  console.log("\nThe stream, then the early show's own file (the same early orders), then the stream again.");
  await schedule(EARLY_AFTER, ["EARLY AM", "DAY", "NIGHT"]);
  const afterStream = exportOf("stream.csv", EARLY_AFTER, [
    { time: "05:00:00 AM", n: 5, base: "99900001" },
    { time: "11:00:00 AM", n: 5, base: "99900002" },
    { time: "06:00:00 PM", n: 5, base: "99900003" },
  ]);
  await mustUpload(afterStream);
  await mustUpload(exportOf("early.csv", EARLY_AFTER, [{ time: "05:00:00 AM", n: 5, base: "99900001" }]));
  await mustUpload(afterStream);
  check("each order on one show, once", [await bySlot(EARLY_AFTER), await countedTwice(EARLY_AFTER)], [{ DAY: 5, "EARLY AM": 5, NIGHT: 5 }, 0]);

  console.log("Then the night's own file too, so the stream is left on the day only; then a short re-export of it.");
  await mustUpload(exportOf("night.csv", EARLY_AFTER, [{ time: "06:00:00 PM", n: 5, base: "99900003" }]));
  const lastShare = await upload(
    exportOf("stream.csv", EARLY_AFTER, [
      { time: "05:00:00 AM", n: 5, base: "99900001" },
      { time: "11:00:00 AM", n: 4, base: "99900002" },
      { time: "06:00:00 PM", n: 5, base: "99900003" },
    ]),
  );
  check(
    "refused as a short copy of the stream, not taken for another show's file",
    [lastShare.status, says(lastShare, "does not have 1 order"), await bySlot(EARLY_AFTER)],
    ["BLOCKED", true, { DAY: 5, "EARLY AM": 5, NIGHT: 5 }],
  );

  /* ------------------------------------------------------- shows that change */

  console.log("\nThe day show called off: its hours belong to the early show.");
  await schedule(CALLED_OFF, ["EARLY AM", "DAY", "NIGHT"], {}, ["DAY"]);
  await mustUpload(
    exportOf("stream.csv", CALLED_OFF, [
      { time: "05:00:00 AM", n: 1, base: "95000001" },
      { time: "12:00:00 PM", n: 4, base: "95000002" },
      { time: "06:00:00 PM", n: 5, base: "95000003" },
    ]),
  );
  check("early 5, night 5", await bySlot(CALLED_OFF), { "EARLY AM": 5, NIGHT: 5 });

  console.log("\nThe stream stopped from 1 to 3 PM Eastern.");
  await schedule(GAP, ["EARLY AM", "DAY", "NIGHT"]);
  await mustUpload(
    exportOf("stream.csv", GAP, [
      { time: "05:00:00 AM", n: 5, base: "96000001" },
      { time: "12:30:00 PM", n: 5, base: "96000002" }, // 3:30 PM ET
      { time: "06:00:00 PM", n: 1, base: "96000003" },
    ]),
  );
  check("shared out all the same", await bySlot(GAP), { DAY: 5, "EARLY AM": 5, NIGHT: 1 });

  console.log("\nA day with only the day and night shows.");
  await schedule(TWO_SHOWS, ["DAY", "NIGHT"]);
  await mustUpload(
    exportOf("stream.csv", TWO_SHOWS, [
      { time: "11:00:00 AM", n: 5, base: "97000001" },
      { time: "06:00:00 PM", n: 5, base: "97000002" },
    ]),
  );
  check("day 5, night 5", await bySlot(TWO_SHOWS), { DAY: 5, NIGHT: 5 });
} finally {
  await clean();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * A parcel whose slip lists more than the packing screen — against a real database.
 *
 * 10/21: Gladys had two TikTok parcels showing 6 watches against slips of 11
 * and 7. 10/20 ran three watch TikTok shows (early, day, night), and the app
 * had combined all three files on each label correctly. The rest had been
 * bought in the 10/21 early show, which was already live when TikTok printed
 * the labels at 5:15 AM Pacific — and its report was not uploaded yet. Nothing
 * on the screen said so, and the box would have closed itself "complete" at 6.
 *
 * 10/22: the yellow "not uploaded yet" warning, and the box that would not
 * close itself while it showed, were taken out again. Gladys compares the
 * printed slip with the screen and sets a short parcel aside herself. So a box
 * closes itself on the last watch the screen lists, whatever is still to be
 * uploaded; these are the same situations, checked against that.
 *
 * The situations:
 *   - a combined order across two shows on one day, the second file later
 *   - a combined order across two days (night, then next morning's early show)
 *   - the early show's orders so far uploaded, then its full file later
 *   - a file re-uploaded unchanged
 *   - a line cancelled (gone from the corrected file), scanned and not
 *   - two packers on the same box at the same moment
 *   - the waiting show called off, or only on a draft schedule
 *   - a day with no shows at all
 *
 * Every file is synthetic and every date years in the past. It refuses to run
 * against anything but a local database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-short-box.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { tiktokReport } from "../src/lib/domain/imports/synthetic-exports";
import type { TiktokOptions } from "../src/lib/domain/imports/synthetic-exports";
import { runImport } from "../src/lib/server/imports";
import { getBoxById, openBoxByScan, packItem, sealBox } from "../src/lib/server/packing";

assertDevDatabase("check-short-box.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

// Summer, Pacific daylight time: 4 AM Pacific is 11:00 UTC.
const TWO_SHOWS = "2021-08-16"; // day and night, one buyer in both
const NIGHT_1 = "2021-08-18"; // early, day, night...
const EARLY_2 = "2021-08-19"; // ...and the next morning's early show
const CANCEL = "2021-08-22";
const PACKERS = "2021-08-24";
const CALLED_OFF = "2021-08-26";
const DRAFT = "2021-08-28";
const NO_SHOWS = "2021-08-30";
const BY_HAND = "2021-09-01";
const NEXT_EARLY = "2021-09-02";
const ALL = [TWO_SHOWS, NIGHT_1, EARLY_2, CANCEL, PACKERS, CALLED_OFF, DRAFT, NO_SHOWS, BY_HAND, NEXT_EARLY];
const PREFIX = "check: short box ";

async function clean() {
  const days = { showDate: { in: ALL.map(toDbDate) } };
  await prisma.scanEvent.deleteMany({ where: { package: days } });
  await prisma.packageItem.deleteMany({ where: { package: days } });
  await prisma.package.deleteMany({ where: days });
  await prisma.importBatch.deleteMany({ where: days });
  await prisma.release.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

const [boss, other] = await prisma.user.findMany({
  where: { isActive: true },
  select: { id: true },
  orderBy: [{ role: "asc" }, { id: "asc" }],
  take: 2,
});
if (!other) throw new Error("needs two active users in the development database");

const HOURS: Record<string, [string, string]> = {
  "EARLY AM": ["11:00", "17:00"],
  DAY: ["17:00", "23:00"],
  NIGHT: ["23:00", "05:00"],
};

/** A watch release with these TikTok shows on a day. */
async function schedule(day: string, slots: string[], { draft = false, cancelled = [] as string[] } = {}) {
  const release = await prisma.release.create({
    data: {
      name: `${PREFIX}${day}`,
      business: "WATCH",
      startDate: toDbDate(day),
      endDate: toDbDate(day),
      scheduleStatus: draft ? "DRAFT" : "PUBLISHED",
    },
    select: { id: true },
  });
  for (const slot of slots) {
    const [start, end] = HOURS[slot];
    const startsAt = new Date(`${day}T${start}:00.000Z`);
    let endsAt = new Date(`${day}T${end}:00.000Z`);
    if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + 24 * 3600_000);
    await prisma.show.create({
      data: {
        releaseId: release.id,
        business: "WATCH",
        date: toDbDate(day),
        platform: "TIKTOK",
        slot,
        status: cancelled.includes(slot) ? "CANCELLED" : "SCHEDULED",
        startsAt,
        endsAt,
      },
    });
  }
}

const DAY_TIME = "10:17:29 AM";
const NIGHT_TIME = "07:05:00 PM";
const EARLY_TIME = "04:30:00 AM";
const tiktok = (name: string, day: string, n: number, base: string, options: TiktokOptions = {}) => ({
  name,
  text: tiktokReport("vaultshowlive", day, n, base, options),
});
const label = (n: number) => `9234690399${String(n).padStart(12, "0")}`;

async function upload(files: { name: string; text: string }[]) {
  const outcome = await runImport(files, boss.id);
  if (outcome.status !== "OK") throw new Error(`upload refused: ${outcome.flags.map((f) => f.message).join(" | ")}`);
  return outcome;
}

async function boxOf(tracking: string) {
  const row = await prisma.package.findUniqueOrThrow({ where: { trackingNumber: tracking }, select: { id: true } });
  return (await getBoxById(row.id))!;
}
const contents = async (tracking: string) =>
  (await boxOf(tracking)).items.map((i) => `${i.stockNumber} ${i.scanned}/${i.expected}`);

await clean();

try {
  /* ------------------------------------------- two shows, one day, one label */

  console.log("One buyer in the day and night shows, on one label; the night file goes up later.");
  await schedule(TWO_SHOWS, ["DAY", "NIGHT"]);
  const L1 = label(1);
  await upload([tiktok("day.csv", TWO_SHOWS, 2, "71000001", { time: DAY_TIME, tracking: L1, buyer: "pat", names: ["A1", "A2"] })]);
  let box = await boxOf(L1);
  check("the box has the day show's two", await contents(L1), ["A1 0/1", "A2 0/1"]);
  await openBoxByScan(boss.id, L1);
  await packItem(boss.id, box.id, "A1");
  const last = await packItem(boss.id, box.id, "A2");
  check(
    "everything on the screen in: it closes itself, night file or not",
    last.kind === "box" && last.autoClosed === true && last.box.status === "CLOSED_COMPLETE",
    true,
  );
  check(
    "the close carries only the usual note, nothing about uploads",
    (await prisma.scanEvent.findFirst({ where: { packageId: box.id, kind: "CLOSE_COMPLETE" }, select: { note: true } }))?.note,
    "Closed automatically: the last item was scanned.",
  );

  console.log("The night file goes up after the box closed itself.");
  const late = await upload([tiktok("night.csv", TWO_SHOWS, 3, "71000002", { time: NIGHT_TIME, tracking: L1, buyer: "pat", names: ["B1", "B2", "B3"] })]);
  check("the closed box is not changed", [await contents(L1), (await boxOf(L1)).status], [["A1 1/1", "A2 1/1"], "CLOSED_COMPLETE"]);
  check(
    "whoever uploads is told that parcel was packed without the night's watches",
    late.flags.some((f) => f.message.includes("packed before this report added a piece") && f.message.includes(L1)),
    true,
  );

  /* ------------------------------------- two days: night, then next early show */

  console.log("\nOne label: a night-show order, and one in the next morning's early show (10/21).");
  await schedule(NIGHT_1, ["EARLY AM", "DAY", "NIGHT"]);
  await schedule(EARLY_2, ["EARLY AM", "DAY", "NIGHT"]);
  const L2 = label(2);
  await upload([tiktok("early.csv", NIGHT_1, 1, "72000001", { time: EARLY_TIME })]);
  await upload([tiktok("day.csv", NIGHT_1, 1, "72000002", { time: DAY_TIME })]);
  await upload([tiktok("night.csv", NIGHT_1, 2, "72000003", { time: NIGHT_TIME, tracking: L2, buyer: "mike", names: ["N1", "N2"] })]);
  box = await boxOf(L2);
  check("the night's two are there", await contents(L2), ["N1 0/1", "N2 0/1"]);

  console.log("The early show's orders so far uploaded, then its whole file later.");
  const early = (n: number) =>
    tiktok(`early-${n}.csv`, EARLY_2, n, "72000004", {
      time: EARLY_TIME,
      tracking: [L2, L2, undefined, undefined],
      buyer: "mike",
      names: ["E1", "E2", "E3", "E4"],
    });
  await upload([early(2)]);
  box = await boxOf(L2);
  check("the box has all four", await contents(L2), ["E1 0/1", "E2 0/1", "N1 0/1", "N2 0/1"]);
  await upload([early(4)]);
  check("the whole file later adds nothing twice", await contents(L2), ["E1 0/1", "E2 0/1", "N1 0/1", "N2 0/1"]);
  check(
    "it went on the early show",
    (await prisma.importBatch.findMany({ where: { showDate: toDbDate(EARLY_2) }, select: { slot: true }, distinct: ["slot"] })).map((b) => b.slot),
    ["EARLY AM"],
  );

  /* ------------------------------------------------------------- a cancellation */

  console.log("\nA line gone from the corrected night file, one scanned and one not.");
  await schedule(CANCEL, ["DAY", "NIGHT"]);
  const L3 = label(3);
  await upload([tiktok("day.csv", CANCEL, 1, "73000001", { time: DAY_TIME, tracking: L3, buyer: "sam", names: ["C1"] })]);
  await upload([tiktok("night.csv", CANCEL, 3, "73000002", { time: NIGHT_TIME, tracking: L3, buyer: "sam", names: ["C2", "C3", "C4"] })]);
  box = await boxOf(L3);
  await openBoxByScan(boss.id, L3);
  await packItem(boss.id, box.id, "C4");
  await upload([tiktok("night-corrected.csv", CANCEL, 1, "73000002", { time: NIGHT_TIME, tracking: L3, buyer: "sam", names: ["C2"] })]);
  check(
    "the unscanned one goes; the scanned one stays, wanted by nobody",
    await contents(L3),
    ["C1 0/1", "C2 0/1", "C4 1/0"],
  );

  /* -------------------------------------------------------- two packers at once */

  console.log("\nTwo packers on the same box at the same moment.");
  await schedule(PACKERS, ["DAY"]);
  const L4 = label(4);
  await upload([tiktok("day.csv", PACKERS, 3, "74000001", { time: DAY_TIME, tracking: L4, buyer: "kim", names: ["P1", "P2", "P2"] })]);
  box = await boxOf(L4);
  await openBoxByScan(boss.id, L4);
  await openBoxByScan(other.id, L4);
  await packItem(boss.id, box.id, "P1");
  // The last two P2s at once, then a third nobody bought.
  await Promise.all([packItem(boss.id, box.id, "P2"), packItem(other.id, box.id, "P2")]);
  const extra = await packItem(other.id, box.id, "P2");
  check("both counted, closed once", [await contents(L4), (await boxOf(L4)).status], [["P1 1/1", "P2 2/2"], "CLOSED_COMPLETE"]);
  check("one close event", await prisma.scanEvent.count({ where: { packageId: box.id, kind: "CLOSE_COMPLETE" } }), 1);
  check("a third P2 is not taken into the closed box", extra.kind === "alreadyPacked" || extra.kind === "refused" || extra.kind === "error", true);

  /* ------------------------------------------------------ shows that do not count */

  console.log("\nThe night show called off, or only on a draft schedule; and a day with no shows.");
  await schedule(CALLED_OFF, ["DAY", "NIGHT"], { cancelled: ["NIGHT"] });
  await schedule(DRAFT, ["DAY", "NIGHT"], { draft: true });
  for (const [day, n] of [[CALLED_OFF, 5], [DRAFT, 6], [NO_SHOWS, 7]] as const) {
    await upload([tiktok("day.csv", day, 1, `7${n}000001`, { time: DAY_TIME, tracking: label(n), buyer: "lee", names: ["Q1"] })]);
    const b = await boxOf(label(n));
    const r = await packItem(boss.id, b.id, "Q1");
    check(`${day}: closes itself as before`, r.kind === "box" && r.autoClosed === true, true);
  }

  /* ---------------------------------- the next early show's file still to come */

  console.log("\nA night-show label, next morning's early show not uploaded: the last scan closes it.");
  await schedule(BY_HAND, ["DAY", "NIGHT"]);
  await schedule(NEXT_EARLY, ["EARLY AM"]);
  const L8 = label(8);
  await upload([tiktok("night.csv", BY_HAND, 1, "78000001", { time: NIGHT_TIME, tracking: L8, buyer: "ann", names: ["M1"] })]);
  box = await boxOf(L8);
  await openBoxByScan(boss.id, L8);
  const m1 = await packItem(boss.id, box.id, "M1");
  check("closes itself complete", m1.kind === "box" && m1.autoClosed === true && m1.box.status === "CLOSED_COMPLETE", true);

  console.log("\nA short box (the slip lists more) closed by hand: nothing added to the note.");
  const L9 = label(9);
  await upload([tiktok("day.csv", BY_HAND, 2, "79000001", { time: DAY_TIME, tracking: L9, buyer: "joy", names: ["K1", "K2"] })]);
  box = await boxOf(L9);
  await packItem(boss.id, box.id, "K1");
  const sealed = await sealBox(boss.id, box.id, true, "slip lists 3");
  check("closed incomplete by hand", sealed.kind === "box" ? sealed.box.status : sealed.kind, "CLOSED_INCOMPLETE");
  check(
    "the note is only what the packer wrote",
    (await prisma.scanEvent.findFirst({ where: { packageId: box.id, kind: "CLOSE_INCOMPLETE" }, select: { note: true } }))?.note,
    "slip lists 3",
  );
} finally {
  await clean();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

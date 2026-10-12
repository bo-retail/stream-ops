/**
 * One diamond export for a day of two diamond shows — against a real database.
 *
 * The diamond shop exports one file for the whole day (10/11: orders 10:33 AM
 * to 9:42 PM) while the schedule has a diamond day show and a diamond night
 * show. The file used to go entirely to the day show: the night pair were
 * credited nothing, and the day read "missing 1 of 4 TikTok exports" forever.
 *
 *   - both shows scheduled, one file: each order goes to the show it was placed in
 *   - the same file uploaded again: nothing doubled
 *   - only a day show scheduled: nothing moves
 *   - a day-show export running a few minutes past the night show's start: nothing moves
 *   - the diamond shop sending one file per show after all: each stays whole
 *   - the night show cancelled: nothing moves
 *   - one buyer in both shows on one label: one box with both pieces
 *   - the watch reports of the same day: untouched
 *
 * Dates are years in the past and everything is removed at the end. It refuses
 * to run against anything but a local database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-diamond-day.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { tiktokReport } from "../src/lib/domain/imports/synthetic-exports";
import type { TiktokOptions } from "../src/lib/domain/imports/synthetic-exports";
import { runImport } from "../src/lib/server/imports";
import { listShowDays } from "../src/lib/server/shipping";

assertDevDatabase("check-diamond-day.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

// Summer, so 4 PM Pacific is 23:00 UTC.
const BOTH = "2022-07-04";
const DAY_ONLY = "2022-07-06";
const OVERRUN = "2022-07-08";
const TWO_FILES = "2022-07-10";
const CANCELLED = "2022-07-12";
// Found by the review: a corrected file has to replace both halves.
const FIX_NIGHT = "2022-07-14"; // night orders cancelled in a correction
const FIX_SCHED = "2022-07-16"; // night show called off after the upload
const FIX_MORNING = "2022-07-18"; // morning orders cancelled in a correction
const FIX_LABEL = "2022-07-20"; // one label in both shows, the night piece cancelled
// Found by the second review.
const FIX_MORNING_ONLY = "2022-07-22"; // whole day, then the morning alone
const FIX_CHECKLIST = "2022-07-24"; // night called off, a watch export still missing
const FIX_TOGETHER = "2022-07-26"; // a whole-day file and a night file in one upload
const FIX_OVERRUN = "2022-07-28"; // a day show running 20 minutes over
// Found by the third review.
const FIX_MOVED = "2022-07-30"; // night show moved later, file uploaded again
const FIX_NO_DAY = "2022-08-01"; // day show called off after the split
const ALL = [
  BOTH, DAY_ONLY, OVERRUN, TWO_FILES, CANCELLED, FIX_NIGHT, FIX_SCHED, FIX_MORNING, FIX_LABEL,
  FIX_MORNING_ONLY, FIX_CHECKLIST, FIX_TOGETHER, FIX_OVERRUN, FIX_MOVED, FIX_NO_DAY,
];
const PREFIX = "check: diamond day ";

async function clean() {
  const days = { showDate: { in: ALL.map(toDbDate) } };
  await prisma.scanEvent.deleteMany({ where: { package: days } });
  await prisma.packageItem.deleteMany({ where: { package: days } });
  await prisma.package.deleteMany({ where: days });
  await prisma.importBatch.deleteMany({ where: days });
  await prisma.release.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

const boss = await prisma.user.findFirstOrThrow({ where: { role: "BOSS", isActive: true }, select: { id: true } });

/** A published release of diamond (and watch) shows on a day. */
async function schedule(day: string, shows: { business: "WATCH" | "DIAMOND"; slot: "DAY" | "NIGHT"; cancelled?: boolean }[]) {
  for (const business of ["WATCH", "DIAMOND"] as const) {
    const mine = shows.filter((s) => s.business === business);
    if (mine.length === 0) continue;
    const release = await prisma.release.create({
      data: { name: `${PREFIX}${business} ${day}`, business, startDate: toDbDate(day), endDate: toDbDate(day), scheduleStatus: "PUBLISHED" },
      select: { id: true },
    });
    for (const s of mine) {
      await prisma.show.create({
        data: {
          releaseId: release.id,
          business,
          date: toDbDate(day),
          platform: "TIKTOK",
          slot: s.slot,
          status: s.cancelled ? "CANCELLED" : "SCHEDULED",
          startsAt: new Date(`${day}T${s.slot === "DAY" ? "17" : "23"}:00:00.000Z`),
          endsAt: s.slot === "DAY" ? new Date(`${day}T23:00:00.000Z`) : new Date(new Date(`${day}T23:00:00.000Z`).getTime() + 6 * 3600_000),
        },
      });
    }
  }
}

/** One diamond file made of rows placed at different times. */
function diamondFile(name: string, day: string, parts: { n: number; base: string; time: string; options?: TiktokOptions; cancelled?: boolean }[]) {
  const texts = parts.map((p) => {
    const text = tiktokReport("caratclublive", day, p.n, p.base, { time: p.time, ...p.options });
    return (p.cancelled ? text.replace(/,To ship,Awaiting collection,/g, ",Canceled,Canceled,") : text).split("\n");
  });
  return { name, text: [texts[0][0], ...texts.flatMap((t) => t.slice(1).filter((l) => l.trim() !== ""))].join("\n") };
}

async function upload(files: { name: string; text: string }[]) {
  const outcome = await runImport(files, boss.id);
  if (outcome.status !== "OK") throw new Error(`upload refused: ${outcome.flags.map((f) => f.message).join(" | ")}`);
  return outcome;
}

/** The day's current diamond sales by show, as the pay reads them. */
/** Each line's newest upload — the one that counts, even when it holds nothing. */
async function currentRows(day: string, business: "WATCH" | "DIAMOND") {
  const batches = await prisma.importBatch.findMany({
    where: { business, status: "OK", showDate: toDbDate(day) },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, platform: true, slot: true },
  });
  const ids = new Map<string, string>();
  for (const b of batches) if (!ids.has(`${b.platform}|${b.slot}`)) ids.set(`${b.platform}|${b.slot}`, b.id);
  return prisma.salesRecord.findMany({
    where: { batchId: { in: [...ids.values()] } },
    select: { show: true, shiftTag: true, orderRef: true, batch: { select: { slot: true } } },
  });
}

async function byShow(day: string, business: "WATCH" | "DIAMOND" = "DIAMOND") {
  const current = await currentRows(day, business);
  const count = (show: string) => current.filter((r) => r.show === show).length;
  return {
    day: count("TikTok AM"),
    night: count("TikTok PM"),
    nightOnNightLine: current.filter((r) => r.show === "TikTok PM").every((r) => r.batch.slot === "NIGHT"),
    nightTags: [...new Set(current.filter((r) => r.show === "TikTok PM").map((r) => r.shiftTag))],
  };
}

async function missing(day: string) {
  const days = await listShowDays(4000);
  const found = days.find((d) => d.dateISO === day);
  return found ? found.missing : "the day is not listed";
}

await clean();
try {
  console.log("Both diamond shows scheduled; the shop sends one file for the day.");
  {
    await schedule(BOTH, [
      { business: "WATCH", slot: "DAY" }, { business: "WATCH", slot: "NIGHT" },
      { business: "DIAMOND", slot: "DAY" }, { business: "DIAMOND", slot: "NIGHT" },
    ]);
    const label = "GFUS01077800000001";
    const file = diamondFile("diamonds.csv", BOTH, [
      { n: 3, base: "96000001", time: "10:33:00 AM", options: { tracking: [undefined, undefined, label], buyer: "buyer.both" } },
      { n: 2, base: "96000002", time: "07:05:00 PM", options: { tracking: [label, undefined], buyer: "buyer.both" } },
    ]);
    const w = (name: string, n: number, base: string, time: string) => ({ name, text: tiktokReport("vaultshowlive", BOTH, n, base, { time }) });
    await upload([w("w-day.csv", 4, "96000003", "10:17:29 AM")]);
    await upload([w("w-night.csv", 2, "96000004", "07:05:00 PM")]);
    check("before the diamond file: the day is waiting for it", (await missing(BOTH)) !== null, true);
    const out = await upload([file]);
    check("each order goes to the show it was placed in", await byShow(BOTH), { day: 3, night: 2, nightOnNightLine: true, nightTags: ["07.04.22 PM"] });
    check("the upload says so", out.flags.some((f) => f.message.includes("2 piece(s) ordered from the night show's start")), true);
    check("the day is complete: nothing missing", await missing(BOTH), null);
    const box = await prisma.package.findUnique({ where: { trackingNumber: label }, select: { items: { select: { expectedQty: true } } } });
    check("a buyer in both shows on one label: one box with both pieces", box?.items.reduce((n, i) => n + i.expectedQty, 0), 2);
    check("the watch reports are untouched", await byShow(BOTH, "WATCH"), { day: 4, night: 2, nightOnNightLine: true, nightTags: ["07.04.22 PM"] });

    await upload([{ ...file, name: "diamonds-again.csv" }]);
    check("the same file again: nothing doubled", await byShow(BOTH), { day: 3, night: 2, nightOnNightLine: true, nightTags: ["07.04.22 PM"] });
    check("still one box on the shared label", await prisma.package.count({ where: { trackingNumber: label } }), 1);
  }

  console.log("\nOnly a diamond day show scheduled, and the file runs into the evening.");
  {
    await schedule(DAY_ONLY, [{ business: "DIAMOND", slot: "DAY" }]);
    await upload([diamondFile("d.csv", DAY_ONLY, [
      { n: 3, base: "96100001", time: "10:33:00 AM" },
      { n: 2, base: "96100002", time: "07:05:00 PM" },
    ])]);
    check("all of it stays on the day show", await byShow(DAY_ONLY), { day: 5, night: 0, nightOnNightLine: true, nightTags: [] });
  }

  console.log("\nBoth scheduled; a day-show export with an order a few minutes after 4 PM.");
  {
    await schedule(OVERRUN, [{ business: "DIAMOND", slot: "DAY" }, { business: "DIAMOND", slot: "NIGHT" }]);
    await upload([diamondFile("d-day.csv", OVERRUN, [
      { n: 3, base: "96200001", time: "10:33:00 AM" },
      { n: 1, base: "96200002", time: "04:01:00 PM" },
    ])]);
    check("the late order stays with the show that sold it", await byShow(OVERRUN), { day: 4, night: 0, nightOnNightLine: true, nightTags: [] });
  }

  console.log("\nBoth scheduled; the shop sends one file per show after all.");
  {
    await schedule(TWO_FILES, [{ business: "DIAMOND", slot: "DAY" }, { business: "DIAMOND", slot: "NIGHT" }]);
    await upload([diamondFile("d-day.csv", TWO_FILES, [{ n: 3, base: "96300001", time: "10:33:00 AM" }])]);
    await upload([diamondFile("d-night.csv", TWO_FILES, [{ n: 2, base: "96300002", time: "07:05:00 PM" }])]);
    check("each file is its own show", await byShow(TWO_FILES), { day: 3, night: 2, nightOnNightLine: true, nightTags: ["07.10.22 PM"] });
    await upload([diamondFile("d-day-again.csv", TWO_FILES, [{ n: 3, base: "96300001", time: "10:33:00 AM" }])]);
    check("the day file again leaves the night alone", await byShow(TWO_FILES), { day: 3, night: 2, nightOnNightLine: true, nightTags: ["07.10.22 PM"] });
  }

  console.log("\nBoth scheduled, but the night show was cancelled.");
  {
    await schedule(CANCELLED, [{ business: "DIAMOND", slot: "DAY" }, { business: "DIAMOND", slot: "NIGHT", cancelled: true }]);
    await upload([diamondFile("d.csv", CANCELLED, [
      { n: 3, base: "96400001", time: "10:33:00 AM" },
      { n: 2, base: "96400002", time: "07:05:00 PM" },
    ])]);
    check("nothing goes to a show that did not run", await byShow(CANCELLED), { day: 5, night: 0, nightOnNightLine: true, nightTags: [] });
  }

  const twoShows = (day: string) => schedule(day, [{ business: "DIAMOND", slot: "DAY" }, { business: "DIAMOND", slot: "NIGHT" }]);
  const dayBoxes = (day: string) => prisma.package.count({ where: { showDate: toDbDate(day) } });
  const boxOf = async (label: string) =>
    (await prisma.package.findUnique({ where: { trackingNumber: label }, select: { items: { select: { expectedQty: true } } } }))?.items.reduce((n, i) => n + i.expectedQty, 0);
  /** Orders the day's current lines count more than once. */
  const twice = async (day: string) => {
    const current = (await currentRows(day, "DIAMOND")).map((r) => r.orderRef);
    return current.length - new Set(current).size;
  };

  console.log("\n[review] Split 3 day / 2 night, then a correction with the night orders cancelled.");
  {
    await twoShows(FIX_NIGHT);
    const day = { n: 3, base: "96500001", time: "10:33:00 AM" };
    await upload([diamondFile("d.csv", FIX_NIGHT, [day, { n: 2, base: "96500002", time: "07:05:00 PM" }])]);
    await upload([diamondFile("d-corrected.csv", FIX_NIGHT, [day, { n: 2, base: "96500002", time: "07:05:00 PM", cancelled: true }])]);
    check("the night half is taken off", await byShow(FIX_NIGHT), { day: 3, night: 0, nightOnNightLine: true, nightTags: [] });
    check("and the cancelled orders' boxes leave the floor", await dayBoxes(FIX_NIGHT), 3);
    check("the day still counts as complete", await missing(FIX_NIGHT), null);
  }

  console.log("\n[review] Split, then the night show is called off, then the same file again.");
  {
    await twoShows(FIX_SCHED);
    const file = diamondFile("d.csv", FIX_SCHED, [
      { n: 3, base: "96600001", time: "10:33:00 AM" },
      { n: 2, base: "96600002", time: "07:05:00 PM" },
    ]);
    await upload([file]);
    await prisma.show.updateMany({ where: { date: toDbDate(FIX_SCHED), business: "DIAMOND", slot: "NIGHT" }, data: { status: "CANCELLED" } });
    const out = await upload([{ ...file, name: "d-again.csv" }]);
    check("all of it on the day show, nothing left on the night", await byShow(FIX_SCHED), { day: 5, night: 0, nightOnNightLine: true, nightTags: [] });
    check("no order counted twice", await twice(FIX_SCHED), 0);
    check("the upload says the night share was taken off", out.flags.some((f) => f.message.includes("No diamond night show")), true);
  }

  console.log("\n[review] Split, then a correction with every morning order cancelled.");
  {
    await twoShows(FIX_MORNING);
    const night = { n: 2, base: "96700002", time: "07:05:00 PM" };
    await upload([diamondFile("d.csv", FIX_MORNING, [{ n: 3, base: "96700001", time: "10:33:00 AM" }, night])]);
    await upload([diamondFile("d-corrected.csv", FIX_MORNING, [{ n: 3, base: "96700001", time: "10:33:00 AM", cancelled: true }, night])]);
    check("the night orders stay the night's, the day is empty", await byShow(FIX_MORNING), { day: 0, night: 2, nightOnNightLine: true, nightTags: ["07.18.22 PM"] });
    check("no order counted twice", await twice(FIX_MORNING), 0);
  }

  console.log("\n[review] One label with a day piece and a night piece; the night piece cancelled.");
  {
    await twoShows(FIX_LABEL);
    const label = "GFUS01077800000002";
    const options = { tracking: label, buyer: "buyer.label" };
    const day = { n: 1, base: "96800001", time: "10:33:00 AM", options };
    await upload([diamondFile("d.csv", FIX_LABEL, [day, { n: 1, base: "96800002", time: "07:05:00 PM", options }])]);
    check("first: one box of two", await boxOf(label), 2);
    await upload([diamondFile("d-corrected.csv", FIX_LABEL, [day, { n: 1, base: "96800002", time: "07:05:00 PM", options, cancelled: true }])]);
    check("after: one box of one", await boxOf(label), 1);
    check("and nothing on the night", (await byShow(FIX_LABEL)).night, 0);
  }

  console.log("\n[review 2] Whole-day file in, then an export of the morning alone.");
  {
    await twoShows(FIX_MORNING_ONLY);
    const day = { n: 3, base: "96900001", time: "10:33:00 AM" };
    await upload([diamondFile("d.csv", FIX_MORNING_ONLY, [day, { n: 2, base: "96900002", time: "07:05:00 PM" }])]);
    await upload([diamondFile("d-morning.csv", FIX_MORNING_ONLY, [day])]);
    check("the night's half and its boxes stay", [await byShow(FIX_MORNING_ONLY), await dayBoxes(FIX_MORNING_ONLY)], [
      { day: 3, night: 2, nightOnNightLine: true, nightTags: ["07.22.22 PM"] },
      5,
    ]);
  }

  console.log("\n[review 2] Diamond night show called off; a watch export is still missing.");
  {
    await schedule(FIX_CHECKLIST, [
      { business: "WATCH", slot: "DAY" }, { business: "WATCH", slot: "NIGHT" },
      { business: "DIAMOND", slot: "DAY" }, { business: "DIAMOND", slot: "NIGHT" },
    ]);
    await upload([{ name: "w-day.csv", text: tiktokReport("vaultshowlive", FIX_CHECKLIST, 2, "97000001", {}) }]);
    const file = diamondFile("d.csv", FIX_CHECKLIST, [
      { n: 3, base: "97000002", time: "10:33:00 AM" },
      { n: 2, base: "97000003", time: "07:05:00 PM" },
    ]);
    await upload([file]);
    await prisma.show.updateMany({ where: { date: toDbDate(FIX_CHECKLIST), business: "DIAMOND", slot: "NIGHT" }, data: { status: "CANCELLED" } });
    await upload([{ ...file, name: "d-again.csv" }]);
    check("the diamonds are all the day show's", await byShow(FIX_CHECKLIST), { day: 5, night: 0, nightOnNightLine: true, nightTags: [] });
    check("and the day is still waiting for the watch night export", (await missing(FIX_CHECKLIST)) !== null, true);
  }

  console.log("\n[review 2] A corrected whole-day file and a night file uploaded together.");
  {
    await twoShows(FIX_TOGETHER);
    const whole = diamondFile("d.csv", FIX_TOGETHER, [
      { n: 3, base: "97100001", time: "10:33:00 AM" },
      { n: 2, base: "97100002", time: "07:05:00 PM" },
    ]);
    await upload([whole]);
    const both = await runImport(
      [{ ...whole, name: "d-corrected.csv" }, diamondFile("d-night.csv", FIX_TOGETHER, [{ n: 2, base: "97100002", time: "07:05:00 PM" }])],
      boss.id,
    );
    check("refused, saying why", [both.status, both.flags.some((f) => f.message.includes("counted twice"))], ["BLOCKED", true]);
    check("and what was there stays", await byShow(FIX_TOGETHER), { day: 3, night: 2, nightOnNightLine: true, nightTags: ["07.26.22 PM"] });
  }

  console.log("\n[review 2] A diamond day show running 20 minutes into the night show's time.");
  {
    await twoShows(FIX_OVERRUN);
    await upload([diamondFile("d-day.csv", FIX_OVERRUN, [
      { n: 3, base: "97200001", time: "10:33:00 AM" },
      { n: 1, base: "97200002", time: "04:20:00 PM" },
    ])]);
    check("still all the day show's", await byShow(FIX_OVERRUN), { day: 4, night: 0, nightOnNightLine: true, nightTags: [] });
  }

  console.log("\n[review 3] Split, then the night show moved to 9 PM, then the same file again.");
  {
    await twoShows(FIX_MOVED);
    const file = diamondFile("d.csv", FIX_MOVED, [
      { n: 3, base: "97300001", time: "10:33:00 AM" },
      { n: 2, base: "97300002", time: "07:05:00 PM" },
    ]);
    await upload([file]);
    await prisma.show.updateMany({
      where: { date: toDbDate(FIX_MOVED), business: "DIAMOND", slot: "NIGHT" },
      // 9 PM Pacific: five hours after 4 PM.
      data: { startsAt: new Date(new Date(`${FIX_MOVED}T23:00:00.000Z`).getTime() + 5 * 3600_000) },
    });
    await upload([{ ...file, name: "d-again.csv" }]);
    check("the 7 PM orders are the day show's now, and only the day's", await byShow(FIX_MOVED), { day: 5, night: 0, nightOnNightLine: true, nightTags: [] });
    check("no order counted twice", await twice(FIX_MOVED), 0);
  }

  console.log("\n[review 3] Split, then the day show called off; the night show still ran.");
  {
    await twoShows(FIX_NO_DAY);
    const file = diamondFile("d.csv", FIX_NO_DAY, [
      { n: 3, base: "97400001", time: "10:33:00 AM" },
      { n: 2, base: "97400002", time: "07:05:00 PM" },
    ]);
    await upload([file]);
    await prisma.show.updateMany({ where: { date: toDbDate(FIX_NO_DAY), business: "DIAMOND", slot: "DAY" }, data: { status: "CANCELLED" } });
    await upload([{ ...file, name: "d-again.csv" }]);
    check("the night show keeps its own orders", (await byShow(FIX_NO_DAY)).night, 2);
    check("no order counted twice", await twice(FIX_NO_DAY), 0);
  }
} catch (error) {
  failures++;
  console.log(`FAIL  stopped: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  console.log("\nCleaning up.");
  await clean();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll diamond day checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

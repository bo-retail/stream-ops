/**
 * A report uploaded with a wrongly pinned watch, then corrected — against a real database.
 *
 * 10/22: twice a show's report went up before Gladys changed a wrongly pinned
 * stock number, and shipping had already started on the other orders. The
 * same report, with only that stock number changed, is uploaded again for the
 * same show. The order with the mistake has not been packed; others have.
 *
 * The situations:
 *   - the order with the mistake, not packed: its box lists the right watch only
 *   - the other orders of the report, already packed: left as they are
 *   - another order of the report not packed yet: unchanged, still packs
 *   - the sales follow the correction, once each
 *   - the corrected file uploaded twice by mistake
 *
 * Every file is synthetic and every date years in the past. It refuses to run
 * against anything but a local database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-sku-correction.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { tiktokReport } from "../src/lib/domain/imports/synthetic-exports";
import { runImport } from "../src/lib/server/imports";
import { latestBatchIds } from "../src/lib/server/sales-data";
import { getBoxById, openBoxByScan, packItem } from "../src/lib/server/packing";

assertDevDatabase("check-sku-correction.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const DAY = "2021-10-04";
const PREFIX = "check: sku correction ";

async function clean() {
  const days = { showDate: toDbDate(DAY) };
  await prisma.scanEvent.deleteMany({ where: { package: days } });
  await prisma.packageItem.deleteMany({ where: { package: days } });
  await prisma.package.deleteMany({ where: days });
  await prisma.importBatch.deleteMany({ where: days });
  await prisma.release.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

const [boss] = await prisma.user.findMany({
  where: { isActive: true },
  select: { id: true },
  orderBy: [{ role: "asc" }, { id: "asc" }],
  take: 1,
});

const label = (n: number) => `9234690388${String(n).padStart(12, "0")}`;
const WRONG = label(1); // the order with the wrongly pinned watch, not packed
const PACKED_A = label(2);
const PACKED_B = label(3);
const LATER = label(4); // another order, not packed yet either

/** One day-show report, four orders. Only the first watch differs between the two files. */
const report = (name: string, first: string) => ({
  name,
  text: tiktokReport("vaultshowlive", DAY, 4, "81000001", {
    tracking: [WRONG, PACKED_A, PACKED_B, LATER],
    names: [first, "OK2", "OK3", "OK4"],
  }),
});

async function upload(file: { name: string; text: string }) {
  const outcome = await runImport([file], boss.id);
  if (outcome.status !== "OK") throw new Error(`upload refused: ${outcome.flags.map((f) => f.message).join(" | ")}`);
  return outcome;
}
async function boxOf(tracking: string) {
  const row = await prisma.package.findUniqueOrThrow({ where: { trackingNumber: tracking }, select: { id: true } });
  return (await getBoxById(row.id))!;
}
const contents = async (tracking: string) => (await boxOf(tracking)).items.map((i) => `${i.stockNumber} ${i.scanned}/${i.expected}`);
const sales = async () =>
  (
    await prisma.salesRecord.findMany({
      // Read the way every sales figure in the app reads them: the newest upload per show.
      where: { batchId: { in: await latestBatchIds(DAY, DAY) } },
      select: { stockNumber: true },
      orderBy: { stockNumber: "asc" },
    })
  ).map((s) => s.stockNumber);

await clean();

try {
  const release = await prisma.release.create({
    data: { name: `${PREFIX}${DAY}`, business: "WATCH", startDate: toDbDate(DAY), endDate: toDbDate(DAY), scheduleStatus: "PUBLISHED" },
    select: { id: true },
  });
  await prisma.show.create({
    data: {
      releaseId: release.id,
      business: "WATCH",
      date: toDbDate(DAY),
      platform: "TIKTOK",
      slot: "DAY",
      status: "SCHEDULED",
      startsAt: new Date(`${DAY}T17:00:00.000Z`),
      endsAt: new Date(`${DAY}T23:00:00.000Z`),
    },
  });

  console.log("The report goes up with the wrong watch pinned on one order (WRONG1).");
  await upload(report("day.xlsx", "WRONG1"));
  check("sales as uploaded", await sales(), ["OK2", "OK3", "OK4", "WRONG1"]);

  console.log("Shipping packs two of the other orders; the order with the mistake is left alone.");
  for (const [t, s] of [[PACKED_A, "OK2"], [PACKED_B, "OK3"]] as const) {
    const b = await boxOf(t);
    await openBoxByScan(boss.id, t);
    await packItem(boss.id, b.id, s);
  }
  check("those two closed", [(await boxOf(PACKED_A)).status, (await boxOf(PACKED_B)).status], ["CLOSED_COMPLETE", "CLOSED_COMPLETE"]);

  console.log("\nThe corrected report (RIGHT1 in place of WRONG1) uploaded for the same show.");
  const fixed = await upload(report("day corrected.xlsx", "RIGHT1"));
  for (const f of fixed.flags) console.log(`   upload says [${f.severity}]: ${f.message}`);
  check("the order with the mistake now lists only the right watch", await contents(WRONG), ["RIGHT1 0/1"]);
  check("sales: the right watch, nothing counted twice", await sales(), ["OK2", "OK3", "OK4", "RIGHT1"]);
  check("the day reads one upload for the show: the corrected one", (await latestBatchIds(DAY, DAY)).length, 1);
  check(
    "the packed parcels are left as they were",
    [await contents(PACKED_A), (await boxOf(PACKED_A)).status, await contents(PACKED_B), (await boxOf(PACKED_B)).status],
    [["OK2 1/1"], "CLOSED_COMPLETE", ["OK3 1/1"], "CLOSED_COMPLETE"],
  );
  check("no warning about parcels packed wrong", fixed.flags.some((f) => /packed/i.test(f.message)), false);
  check("the other unpacked order is unchanged", await contents(LATER), ["OK4 0/1"]);

  console.log("\nBoth unpacked orders packed.");
  const w = await boxOf(WRONG);
  await openBoxByScan(boss.id, WRONG);
  const wrongScan = await packItem(boss.id, w.id, "WRONG1");
  check("scanning the old wrong watch is not accepted as the order", wrongScan.kind === "box" && wrongScan.box.status === "CLOSED_COMPLETE", false);
  console.log(`   scanning WRONG1 gives: ${wrongScan.kind}${"message" in wrongScan && wrongScan.message ? ` — ${wrongScan.message}` : ""}`);
  const right = await packItem(boss.id, w.id, "RIGHT1");
  console.log(`   then RIGHT1 gives: ${right.kind}${right.kind === "box" ? ` ${right.box.status}` : ""}`);
  const l = await boxOf(LATER);
  const later = await packItem(boss.id, l.id, "OK4");
  check("the other one closes itself as usual", later.kind === "box" && later.box.status === "CLOSED_COMPLETE", true);

  console.log("\nThe corrected report uploaded a second time by mistake.");
  await upload(report("day corrected (1).xlsx", "RIGHT1"));
  check("sales unchanged", await sales(), ["OK2", "OK3", "OK4", "RIGHT1"]);
  check("packed parcels unchanged", [(await boxOf(PACKED_A)).status, (await boxOf(LATER)).status], ["CLOSED_COMPLETE", "CLOSED_COMPLETE"]);
} finally {
  await clean();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

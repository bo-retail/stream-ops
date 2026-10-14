/**
 * An eBay order paid and then refunded — eBay shows $0 paid — against a real
 * database.
 *
 * 10/13: order 39632 (49163, $70, chik-3425) had a Paid On Date and a Total
 * Price of $0.00, and counted as a second sale of a watch sold once. Pipe
 * checked in Seller Hub: cancelled by the buyer, money refunded. What has to
 * hold now:
 *
 *   - a $0 order is no sale, sits on the exceptions list, and is warned about
 *   - every other order in the file is read as before
 *   - a corrected file in which an order has since been refunded takes its
 *     sale away and its unpacked box off the floor
 *   - a box already packed and closed is never touched — it is reported
 *   - the same file uploaded twice changes nothing
 *
 * Found by the review (10/14):
 *   - one of two orders on a packed label refunded: the parcel is named, with
 *     the watch to take out
 *   - a late payer counted on the day before, refunded since: that day named,
 *     until that day is uploaded again; never a diamond order with the same number
 *   - a parcel marked sent in bulk: no "pull it" — it has gone
 *
 * Dates are years in the past and everything is removed at the end. It refuses
 * to run against anything but a local database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-ebay-refunded.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { ebayReport } from "../src/lib/domain/imports/synthetic-exports";
import type { EbayOrder } from "../src/lib/domain/imports/synthetic-exports";
import { runImport } from "../src/lib/server/imports";

assertDevDatabase("check-ebay-refunded.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const FIRST = "2019-05-06";
const LATER = "2019-05-08";
const CLOSED = "2019-05-10";
const SHARED = "2019-05-12";
const LATE_SOLD = "2019-05-14";
const LATE_PAID = "2019-05-15";
const SENT = "2019-05-17";
const ALL = [FIRST, LATER, CLOSED, SHARED, LATE_SOLD, LATE_PAID, SENT];
const PREFIX = "check: ebay refunded ";

async function clean() {
  const days = { showDate: { in: ALL.map(toDbDate) } };
  await prisma.scanEvent.deleteMany({ where: { package: days } });
  await prisma.packageItem.deleteMany({ where: { package: days } });
  await prisma.package.deleteMany({ where: days });
  await prisma.importBatch.deleteMany({ where: days });
  await prisma.release.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

const boss = await prisma.user.findFirstOrThrow({ where: { role: "BOSS", isActive: true }, select: { id: true } });

/** A published watch release with an eBay night show on the day. */
async function schedule(day: string) {
  const release = await prisma.release.create({
    data: { name: `${PREFIX}${day}`, business: "WATCH", startDate: toDbDate(day), endDate: toDbDate(day), scheduleStatus: "PUBLISHED" },
    select: { id: true },
  });
  await prisma.show.create({
    data: {
      releaseId: release.id, business: "WATCH", date: toDbDate(day), platform: "EBAY", slot: "NIGHT",
      startsAt: new Date(`${day}T23:00:00.000Z`), endsAt: new Date(new Date(`${day}T23:00:00.000Z`).getTime() + 6 * 3600_000),
    },
  });
}

const order = (day: string, srn: string, more: Partial<EbayOrder> = {}): EbayOrder => ({
  srn, showDay: day, paidDay: day, price: "$70.00", tracking: `94346081062455${srn.padStart(8, "0")}`, ...more,
});
const file = (day: string, orders: EbayOrder[]) => ({ name: `ebay-${day}-${orders.length}.csv`, text: ebayReport(orders) });

async function upload(f: { name: string; text: string }) {
  const outcome = await runImport([f], boss.id);
  if (outcome.status !== "OK") throw new Error(`upload refused: ${outcome.flags.map((x) => x.message).join(" | ")}`);
  return outcome;
}

/** The day's current eBay sales' orders, and its boxes. */
async function day(d: string) {
  const batch = await prisma.importBatch.findFirst({
    where: { showDate: toDbDate(d), status: "OK", platform: "EBAY" },
    orderBy: { uploadedAt: "desc" },
    select: { sales: { select: { orderRef: true } }, drops: { select: { orderRef: true, reason: true } } },
  });
  const boxes = await prisma.package.findMany({ where: { showDate: toDbDate(d) }, select: { trackingNumber: true, status: true } });
  return {
    sales: [...new Set((batch?.sales ?? []).map((s) => s.orderRef))].sort(),
    refunded: (batch?.drops ?? []).filter((x) => x.reason.includes("refunded")).map((x) => x.orderRef).sort(),
    boxes: boxes.length,
    closed: boxes.filter((b) => b.status !== "OPEN").length,
  };
}

await clean();
try {
  /* ------------------------------------------- the 10/13 case, first upload */
  await schedule(FIRST);
  const first = await upload(file(FIRST, [
    order(FIRST, "39631"),
    order(FIRST, "39632", { total: "$0.00", tracking: "" }),
    order(FIRST, "39633"),
  ]));
  check("a $0 order is no sale, and on the exceptions list", await day(FIRST), {
    sales: ["39631", "39633"], refunded: ["39632"], boxes: 2, closed: 0,
  });
  check(
    "and the upload says so, naming the order",
    first.flags.some((f) => f.severity === "warning" && f.message.includes("$0 paid") && f.message.includes("39632")),
    true,
  );
  await upload(file(FIRST, [
    order(FIRST, "39631"),
    order(FIRST, "39632", { total: "$0.00", tracking: "" }),
    order(FIRST, "39633"),
  ]));
  check("the same file twice: nothing changes", await day(FIRST), {
    sales: ["39631", "39633"], refunded: ["39632"], boxes: 2, closed: 0,
  });

  /* ---------------- refunded after the first upload, box not yet packed */
  await schedule(LATER);
  await upload(file(LATER, [order(LATER, "40001"), order(LATER, "40002")]));
  check("both orders paid at first: two sales, two boxes", await day(LATER), {
    sales: ["40001", "40002"], refunded: [], boxes: 2, closed: 0,
  });
  await upload(file(LATER, [order(LATER, "40001"), order(LATER, "40002", { total: "$0.00" })]));
  check("refunded since: its sale is taken away and its unpacked box off the floor", await day(LATER), {
    sales: ["40001"], refunded: ["40002"], boxes: 1, closed: 0,
  });

  /* ---------------- refunded after the box was already packed and closed */
  await schedule(CLOSED);
  await upload(file(CLOSED, [order(CLOSED, "40101"), order(CLOSED, "40102")]));
  await prisma.package.updateMany({
    where: { showDate: toDbDate(CLOSED), trackingNumber: { endsWith: "40102" } },
    data: { status: "CLOSED_COMPLETE" },
  });
  const after = await upload(file(CLOSED, [order(CLOSED, "40101"), order(CLOSED, "40102", { total: "$0.00" })]));
  check("refunded after it was packed: the sale goes, the closed box is never touched", await day(CLOSED), {
    sales: ["40101"], refunded: ["40102"], boxes: 2, closed: 1,
  });
  check(
    "and the upload says to pull that parcel before it ships, naming it",
    after.flags.some((f) => f.severity === "warning" && f.message.includes("pull each one") && f.message.includes("40102")),
    true,
  );
  /* ------------- one of two orders on a packed label refunded (review C) */
  await schedule(SHARED);
  const label = "9434608106245500777001";
  await upload(file(SHARED, [order(SHARED, "41001", { tracking: label, buyer: "same" }), order(SHARED, "41002", { tracking: label, buyer: "same" })]));
  const box = await prisma.package.findFirstOrThrow({ where: { showDate: toDbDate(SHARED), trackingNumber: label }, select: { id: true } });
  await prisma.packageItem.updateMany({ where: { packageId: box.id }, data: { scannedQty: 1 } });
  await prisma.package.update({ where: { id: box.id }, data: { status: "CLOSED_COMPLETE" } });
  const shared = await upload(file(SHARED, [
    order(SHARED, "41001", { tracking: label, buyer: "same" }),
    order(SHARED, "41002", { tracking: label, buyer: "same", total: "$0.00" }),
  ]));
  check("one of two orders on a packed label refunded: the sale goes", (await day(SHARED)).sales, ["41001"]);
  check(
    "and the parcel is named, with the refunded watch to take out",
    shared.flags.some((f) => f.message.includes(label) && f.message.includes("take out W41002")),
    true,
  );

  /* --------- a late payer counted on the day before, refunded since (F1) */
  await schedule(LATE_SOLD);
  await schedule(LATE_PAID);
  await upload(file(LATE_SOLD, [order(LATE_SOLD, "42001")]));
  await upload(file(LATE_PAID, [order(LATE_PAID, "42101"), order(LATE_SOLD, "42002", { paidDay: LATE_PAID })]));
  check("the late payer is counted on the day it sold", (await day(LATE_SOLD)).sales.includes("42002"), true);
  const lateRefund = await upload(file(LATE_PAID, [
    order(LATE_PAID, "42101"),
    order(LATE_SOLD, "42002", { paidDay: LATE_PAID, total: "$0.00" }),
  ]));
  check(
    "refunded since: the upload names the earlier day to upload again",
    lateRefund.flags.some((f) => f.message.includes("42002") && f.message.includes(`${LATE_SOLD}'s eBay report`)),
    true,
  );

  // Once that day is exported again — eBay now shows the order at $0 there
  // too — and uploaded, it is gone from that day and the warning stops (F3).
  await upload(file(LATE_SOLD, [order(LATE_SOLD, "42001"), order(LATE_SOLD, "42002", { paidDay: LATE_PAID, total: "$0.00" })]));
  check("that day uploaded again: the refunded order is gone from it", (await day(LATE_SOLD)).sales, ["42001"]);
  const settled = await upload(file(LATE_PAID, [
    order(LATE_PAID, "42101"),
    order(LATE_SOLD, "42002", { paidDay: LATE_PAID, total: "$0.00" }),
  ]));
  check("the earlier day fixed: the warning stops", settled.flags.some((f) => f.message.includes(`${LATE_SOLD}'s eBay report`)), false);

  // A diamond-account sale with the same record number is another order (review F4).
  const diamondBatch = await prisma.importBatch.create({
    data: { business: "DIAMOND", platform: "EBAY", showDate: toDbDate(LATE_SOLD), status: "OK", files: [], flags: [] },
    select: { id: true },
  });
  await prisma.salesRecord.create({
    data: {
      batchId: diamondBatch.id, business: "DIAMOND", platform: "EBAY", show: "eBay PM", showDate: toDbDate(LATE_SOLD),
      shiftTag: "", rawShiftTag: "", orderRef: "42102", lineRef: "d1", buyer: "someone", stockNumber: "E1", tracking: "", sourceFile: "diamonds.csv",
    },
  });
  const otherAccount = await upload(file(LATE_PAID, [order(LATE_PAID, "42101"), order(LATE_PAID, "42102", { total: "$0.00" })]));
  check("a diamond order with the same number is not named", otherAccount.flags.some((f) => f.message.includes("still counts")), false);

  /* ------------------------ a parcel marked sent in bulk, then refunded (H) */
  await schedule(SENT);
  await upload(file(SENT, [order(SENT, "43001"), order(SENT, "43002")]));
  await prisma.package.updateMany({ where: { showDate: toDbDate(SENT) }, data: { status: "CLOSED_UNVERIFIED" } });
  const sent = await upload(file(SENT, [order(SENT, "43001"), order(SENT, "43002", { total: "$0.00" })]));
  check("a parcel already sent: no \"pull it\"", sent.flags.some((f) => f.message.includes("pull each one")), false);

  /* ------------------------------- an ordinary re-upload says nothing new */
  const again = await upload(file(SENT, [order(SENT, "43001"), order(SENT, "43002", { total: "$0.00" })]));
  check("the same corrected file again: still no \"pull it\"", again.flags.some((f) => f.message.includes("pull each one")), false);
} finally {
  await clean();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

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
 * Found 10/14: watches and a diamond on one label are one box. Packed and
 * closed, then one side's order cancelled (TikTok) or refunded (eBay $0) and
 * that file uploaded again — no warning, and the parcel would ship with it:
 *   - the diamond cancelled, or both watches: named, with the piece(s)
 *   - one watch of two cancelled: named, with that watch
 *   - the whole parcel cancelled, one side after the other: named each time
 *   - a diamond sold under a placeholder: named by the tag that was scanned
 *   - a diamond never packed (closed before its report): nothing to take out
 *   - a shared parcel marked sent in bulk: no "pull it"
 *   - an eBay watch refunded on a label with a diamond eBay order: named
 *   - ordinary re-uploads of either business, before and after: nothing said
 *
 * Found 10/14: a file whose every order is cancelled was refused with no
 * reason, dated 1970, and the cancellation never reached the day. Now:
 *   - the diamond file's only order, on a packed shared parcel: goes in as its
 *     day, the sale taken away, the parcel named — and the same again twice
 *   - a day never uploaded: goes in as a day with no sale
 *   - a watch file all cancelled: sales gone, unpacked box swept, packed named
 *   - an eBay report with no sale left: refused, saying why; beside TikTok
 *     files, the upload goes in and says the eBay report was not changed
 * And from the review of that: the night file all cancelled with the day
 * file; a stray all-cancelled file (the Canceled tab) refused, the line kept;
 * a shared whole-day diamond file all cancelled; an Early AM file all
 * cancelled; cancelled and never-paid rows; two uploads at the same moment.
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
import { tiktokReport } from "../src/lib/domain/imports/synthetic-exports";
import type { TiktokOptions } from "../src/lib/domain/imports/synthetic-exports";
import { openBoxByScan, packItem } from "../src/lib/server/packing";

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
const MIX_D = "2019-05-19"; // a shared parcel's diamond cancelled
const MIX_W = "2019-05-21"; // its watches cancelled
const MIX_ONE = "2019-05-23"; // one watch of two cancelled
const MIX_ALL = "2019-05-25"; // both sides cancelled, one after the other
const MIX_PH = "2019-05-27"; // the diamond under a placeholder
const MIX_SHORT = "2019-05-29"; // closed before the diamond report
const MIX_SENT = "2019-05-31"; // marked sent in bulk
const MIX_EBAY = "2019-06-02"; // two eBay accounts, one label
// Added by the independent review, 10/14:
const MIX_PH_KEEP = "2019-06-04"; // placeholder renamed to its piece, then the watches cancelled
const MIX_ONLY = "2019-06-06"; // the diamond file's only order cancelled (a real "Canceled" row)
const MIX_CXL = "2019-06-08"; // a real "Canceled" row, not a row left out; the file twice
const TWO_DAY_A = "2019-06-10"; // one label across two watch days, the first day's order cancelled
const TWO_DAY_B = "2019-06-11";
// What-ifs for a file whose every order is cancelled, 10/14:
const NEVER = "2019-06-13"; // a day never uploaded before
const WATCH_ALL = "2019-06-15"; // a watch file, every order cancelled
const EBAY_NONE = "2019-06-17"; // an eBay report whose only order was refunded
// From the independent review of that fix:
const WA_PAIR = "2019-06-19"; // the day file and an all-cancelled night file
const WA_WRONG = "2019-06-21"; // an all-cancelled file that is not the line's export
const DI_WHOLE = "2019-06-23"; // two diamond shows, the shared whole-day file all cancelled
const EARLY_D = "2019-06-25"; // an Early AM show's file all cancelled
const EB_PAIR = "2019-06-27"; // TikTok beside an eBay report with no sale
const MIXED_NP = "2019-06-29"; // cancelled and never-paid rows
const AT_ONCE = "2019-07-01"; // two uploads at the same moment
const ALL = [
  FIRST, LATER, CLOSED, SHARED, LATE_SOLD, LATE_PAID, SENT,
  MIX_D, MIX_W, MIX_ONE, MIX_ALL, MIX_PH, MIX_SHORT, MIX_SENT, MIX_EBAY,
  MIX_PH_KEEP, MIX_ONLY, MIX_CXL, TWO_DAY_A, TWO_DAY_B, NEVER, WATCH_ALL, EBAY_NONE,
  WA_PAIR, WA_WRONG, DI_WHOLE, EARLY_D, EB_PAIR, MIXED_NP, AT_ONCE,
];
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
async function schedule(day: string, business: "WATCH" | "DIAMOND" = "WATCH") {
  const release = await prisma.release.create({
    data: { name: `${PREFIX}${business} ${day}`, business, startDate: toDbDate(day), endDate: toDbDate(day), scheduleStatus: "PUBLISHED" },
    select: { id: true },
  });
  await prisma.show.create({
    data: {
      releaseId: release.id, business, date: toDbDate(day), platform: "EBAY", slot: "NIGHT",
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

  /* ------------- 10/14: watches and a diamond on one label, packed, then one side gone */
  const watches = (name: string, d: string, n: number, base: string, options: TiktokOptions) => ({
    name, text: tiktokReport("vaultshowlive", d, n, base, options),
  });
  const diamonds = (name: string, d: string, n: number, base: string, options: TiktokOptions) => ({
    name, text: tiktokReport("caratclublive", d, n, base, options),
  });
  const watchesOn = (l: string) => ({ names: ["W90001", "W90002", "W90003"], tracking: [l, l, undefined], buyer: "buyer.mix" });
  const diamondOn = (l: string) => ({ names: ["E93557", "E90009"], tracking: [l, undefined], buyer: "buyer.mix" });
  const noDiamond = { names: ["E90009"], buyer: "buyer.mix" };
  const items = async (l: string) =>
    (await prisma.package.findUnique({ where: { trackingNumber: l }, select: { items: { select: { stockNumber: true, scannedQty: true, expectedQty: true } } } }))
      ?.items.map((i) => `${i.stockNumber} ${i.scannedQty}/${i.expectedQty}`).sort() ?? null;
  /** A business's TikTok line on a day as its newest upload holds it. */
  const line = async (business: "WATCH" | "DIAMOND", d: string) => {
    const b = await prisma.importBatch.findFirst({
      where: { business, showDate: toDbDate(d), status: "OK", platform: "TIKTOK" },
      orderBy: { uploadedAt: "desc" },
      select: { slot: true, sales: { select: { orderRef: true } }, drops: { select: { orderRef: true } } },
    });
    return b && { slot: b.slot, sales: b.sales.map((s) => s.orderRef).sort(), drops: b.drops.map((s) => s.orderRef).sort() };
  };
  const lineSales = async (business: "WATCH" | "DIAMOND", d: string) => (await line(business, d))?.sales ?? null;
  const status = async (l: string) => (await prisma.package.findUnique({ where: { trackingNumber: l }, select: { status: true } }))?.status;
  /** Every piece scanned in; the last one closes it. */
  const pack = async (l: string, tags: string[]) => {
    const opened = await openBoxByScan(boss.id, l);
    if (opened.kind !== "box") throw new Error(`${l} did not open: ${opened.kind}`);
    for (const t of tags) await packItem(boss.id, opened.box.id, t);
  };
  /** What the upload said about this label: the pieces to take out, if any. */
  const said = (o: Awaited<ReturnType<typeof upload>>, l: string) =>
    o.flags
      .filter((f) => f.message.includes(l))
      .map((f) => /^ \(take out ([^)]*)\)/.exec(f.message.slice(f.message.indexOf(l) + l.length))?.[1] ?? "named, no piece");

  console.log("\n[10/14] A packed parcel of two watches and a diamond, the diamond cancelled.");
  {
    const l = "GFUS01990000000001";
    await upload(watches("w.csv", MIX_D, 3, "96000001", watchesOn(l)));
    await upload(diamonds("d.csv", MIX_D, 2, "96000002", diamondOn(l)));
    await pack(l, ["W90001", "W90002", "E93557"]);
    check("packed and closed", await status(l), "CLOSED_COMPLETE");
    check("the watch file again: nothing said", said(await upload(watches("w2.csv", MIX_D, 3, "96000001", watchesOn(l))), l), []);
    check("the diamond file again: nothing said", said(await upload(diamonds("d2.csv", MIX_D, 2, "96000002", diamondOn(l))), l), []);
    const cut = await upload(diamonds("d3.csv", MIX_D, 1, "96000002", noDiamond));
    check("diamond cancelled: the parcel is named, take out the diamond", said(cut, l), ["E93557"]);
    check(
      "as a warning to pull it",
      cut.flags.some((f) => f.severity === "warning" && f.message.includes(l) && f.message.includes("pull each one")),
      true,
    );
    check("and the closed box is untouched", await items(l), ["E93557 1/1", "W90001 1/1", "W90002 1/1"]);
    check("the watch file again after: still named until it is pulled", said(await upload(watches("w3.csv", MIX_D, 3, "96000001", watchesOn(l))), l), ["E93557"]);
  }

  console.log("\n[10/14] The same parcel, both watches cancelled.");
  {
    const l = "GFUS01990000000002";
    await upload(watches("w.csv", MIX_W, 3, "96000003", watchesOn(l)));
    await upload(diamonds("d.csv", MIX_W, 2, "96000004", diamondOn(l)));
    await pack(l, ["W90001", "W90002", "E93557"]);
    const cut = await upload(watches("w2.csv", MIX_W, 1, "96000003", { names: ["W90003"], buyer: "buyer.mix" }));
    check("watches cancelled: named, take out both watches, not the diamond", said(cut, l), ["W90001, W90002"]);
    check("the diamond file again after: still named until it is pulled", said(await upload(diamonds("d2.csv", MIX_W, 2, "96000004", diamondOn(l))), l), ["W90001, W90002"]);
  }

  console.log("\n[10/14] The same parcel, one watch of two cancelled.");
  {
    const l = "GFUS01990000000003";
    await upload(watches("w.csv", MIX_ONE, 3, "96000005", watchesOn(l)));
    await upload(diamonds("d.csv", MIX_ONE, 2, "96000006", diamondOn(l)));
    await pack(l, ["W90001", "W90002", "E93557"]);
    const cut = await upload(
      watches("w2.csv", MIX_ONE, 2, "96000005", { names: ["W90001", "W90003"], tracking: [l, undefined], buyer: "buyer.mix" }),
    );
    check("one watch cancelled: named, take out that watch", said(cut, l), ["W90002"]);
  }

  console.log("\n[10/14] The whole parcel cancelled, the watches first, then the diamond.");
  {
    const l = "GFUS01990000000004";
    await upload(watches("w.csv", MIX_ALL, 3, "96000007", watchesOn(l)));
    await upload(diamonds("d.csv", MIX_ALL, 2, "96000008", diamondOn(l)));
    await pack(l, ["W90001", "W90002", "E93557"]);
    const w = await upload(watches("w2.csv", MIX_ALL, 1, "96000007", { names: ["W90003"], buyer: "buyer.mix" }));
    check("watches gone: take out the watches", said(w, l), ["W90001, W90002"]);
    const d = await upload(diamonds("d2.csv", MIX_ALL, 1, "96000008", noDiamond));
    check("then the diamond: named again, nothing in it is sold now", said(d, l).length, 1);
    check("naming the diamond", said(d, l)[0]?.includes("E93557"), true);
  }

  console.log("\n[10/14] The diamond sold under a placeholder, its tag scanned, then cancelled.");
  {
    const l = "GFUS01990000000005";
    const lgd = "LGD - As seen on screen";
    await upload(watches("w.csv", MIX_PH, 3, "96000009", watchesOn(l)));
    await upload(diamonds("d.csv", MIX_PH, 2, "96000010", { ...diamondOn(l), names: [lgd, "E90009"] }));
    await pack(l, ["W90001", "W90002", "E55501"]);
    check("the piece's tag closed it", await status(l), "CLOSED_COMPLETE");
    check(
      "the diamond file again: nothing said",
      said(await upload(diamonds("d2.csv", MIX_PH, 2, "96000010", { ...diamondOn(l), names: [lgd, "E90009"] })), l),
      [],
    );
    check(
      "renamed to the piece that was scanned: nothing said",
      said(await upload(diamonds("d3.csv", MIX_PH, 2, "96000010", { ...diamondOn(l), names: ["E55501", "E90009"] })), l),
      [],
    );
    const cut = await upload(diamonds("d4.csv", MIX_PH, 1, "96000010", noDiamond));
    check("cancelled: named by the tag that went in", said(cut, l), ["E55501"]);
  }

  console.log("\n[10/14] The watches closed before the diamond report, then the diamond cancelled.");
  {
    const l = "GFUS01990000000006";
    await upload(watches("w.csv", MIX_SHORT, 3, "96000011", watchesOn(l)));
    await pack(l, ["W90001", "W90002"]);
    await upload(diamonds("d.csv", MIX_SHORT, 2, "96000012", diamondOn(l)));
    const cut = await upload(diamonds("d2.csv", MIX_SHORT, 1, "96000012", noDiamond));
    check("the diamond never went in: nothing to take out", said(cut, l), []);
  }

  console.log("\n[10/14] A shared parcel marked sent in bulk, then the diamond cancelled.");
  {
    const l = "GFUS01990000000007";
    await upload(watches("w.csv", MIX_SENT, 3, "96000013", watchesOn(l)));
    await upload(diamonds("d.csv", MIX_SENT, 2, "96000014", diamondOn(l)));
    await prisma.package.update({ where: { trackingNumber: l }, data: { status: "CLOSED_UNVERIFIED" } });
    const cut = await upload(diamonds("d2.csv", MIX_SENT, 1, "96000014", noDiamond));
    check("it has gone: no \"pull it\"", said(cut, l), []);
  }

  console.log("\n[10/14] An eBay watch refunded on a label shared with a diamond eBay order.");
  {
    const l = "GFUS01990000000008";
    await schedule(MIX_EBAY, "DIAMOND");
    const watchFile = (orders: EbayOrder[]) => file(MIX_EBAY, orders);
    // The diamond account's export: its own seller line, its own stock numbers.
    const diamondFile = (orders: EbayOrder[]) => {
      const f = file(MIX_EBAY, orders);
      return {
        name: `d-${f.name}`,
        text: f.text.replace("Seller ID : vaultshowofficial", "Seller ID : caratclubofficial").replace(/\bW(4400\d)\b/g, "E$1"),
      };
    };
    const watchOrders = (more: Partial<EbayOrder> = {}) => [order(MIX_EBAY, "44001", { tracking: l, buyer: "same", ...more }), order(MIX_EBAY, "44003")];
    const diamondOrders = [order(MIX_EBAY, "44002", { tracking: l, buyer: "same" }), order(MIX_EBAY, "44004")];
    await upload(watchFile(watchOrders()));
    await upload(diamondFile(diamondOrders));
    check("one box with both", await items(l), ["E44002 0/1", "W44001 0/1"]);
    await pack(l, ["W44001", "E44002"]);
    check("packed and closed", await status(l), "CLOSED_COMPLETE");
    check("the watch file again: nothing said", said(await upload(watchFile(watchOrders())), l), []);
    check("the diamond file again: nothing said", said(await upload(diamondFile(diamondOrders)), l), []);
    const refunded = await upload(watchFile(watchOrders({ total: "$0.00" })));
    check("the watch refunded: named, take out the watch", said(refunded, l), ["W44001"]);
    check("the diamond file again after: still named until it is pulled", said(await upload(diamondFile(diamondOrders)), l), ["W44001"]);
  }

  /* ----------------- review what-ifs, 10/14: the shared-label block, the awkward days */
  /** The same file with one order's row turned into TikTok's own cancelled row. */
  const cancelled = (f: { name: string; text: string }, orderId: string) => ({
    name: f.name,
    text: f.text
      .split("\r\n")
      .map((line) => (line.includes(`${orderId}\t`) ? line.replace(",To ship,Awaiting collection,", ",Canceled,,") : line))
      .join("\r\n"),
  });

  console.log("\n[review] Placeholder renamed to the piece scanned, then the watches cancelled.");
  {
    const l = "GFUS01990000000011";
    const lgd = "LGD - As seen on screen";
    await upload(watches("w.csv", MIX_PH_KEEP, 3, "96000021", watchesOn(l)));
    await upload(diamonds("d.csv", MIX_PH_KEEP, 2, "96000022", { ...diamondOn(l), names: [lgd, "E90009"] }));
    await pack(l, ["W90001", "W90002", "E55501"]);
    check("closed", await status(l), "CLOSED_COMPLETE");
    await upload(diamonds("d2.csv", MIX_PH_KEEP, 2, "96000022", { ...diamondOn(l), names: ["E55501", "E90009"] }));
    const cut = await upload(watches("w2.csv", MIX_PH_KEEP, 1, "96000021", { names: ["W90003"], buyer: "buyer.mix" }));
    check("watches cancelled: take out the watches only — the diamond is still sold", said(cut, l), ["W90001, W90002"]);
  }

  console.log("\n[review] The diamond file's only order is the shared one, and it is cancelled.");
  {
    const l = "GFUS01990000000012";
    await upload(watches("w.csv", MIX_ONLY, 3, "96000023", watchesOn(l)));
    const d = diamonds("d.csv", MIX_ONLY, 1, "96000024", { names: ["E93557"], tracking: [l], buyer: "buyer.mix" });
    await upload(d);
    await pack(l, ["W90001", "W90002", "E93557"]);
    check("closed", await status(l), "CLOSED_COMPLETE");
    // Not through `upload`, which throws on a refusal: until 10/14 a file
    // whose every order is cancelled was refused with no reason, dated 1970,
    // and the cancellation never reached the day. Removed here if it ever is again.
    const cut = await runImport([cancelled({ ...d, name: "d2.csv" }, "960000240000")], boss.id);
    if (cut.status !== "OK" && cut.batchId) await prisma.importBatch.delete({ where: { id: cut.batchId } });
    check("every diamond order cancelled: the upload goes in, as that day", [cut.status, cut.showDate, cut.business], ["OK", MIX_ONLY, "DIAMOND"]);
    check("and the parcel is named, take out the diamond", said(cut, l), ["E93557"]);
    check(
      "and the upload says the show has no sales now",
      cut.flags.some((f) => f.severity === "info" && f.message.includes("every order in it was cancelled")),
      true,
    );
    check("the diamond line holds no sale now", await lineSales("DIAMOND", MIX_ONLY), []);
    check("the watch line is untouched", await lineSales("WATCH", MIX_ONLY), ["960000230000", "960000230001", "960000230002"]);

    // What-if (10/14): the same all-cancelled file uploaded twice.
    const twice = await upload(cancelled({ ...d, name: "d3.csv" }, "960000240000"));
    check("all cancelled, twice: goes in again, still no sale", await lineSales("DIAMOND", MIX_ONLY), []);
    check("and the parcel is still named, once", said(twice, l), ["E93557"]);
    check("and the closed box is never touched", await items(l), ["E93557 1/1", "W90001 1/1", "W90002 1/1"]);
  }

  console.log("\n[what-if] An all-cancelled file for a day that was never uploaded.");
  {
    const cut = await upload(cancelled(diamonds("d.csv", NEVER, 1, "96000031", { names: ["E93999"], buyer: "x" }), "960000310000"));
    check("goes in as that day, with no sale", [cut.status, cut.showDate, cut.watchCount, cut.boxCount], ["OK", NEVER, 0, 0]);
    check("on the diamond TikTok day line, its row on the exceptions list", await line("DIAMOND", NEVER), {
      slot: "DAY", sales: [], drops: ["960000310000"],
    });
    check("and no box", await prisma.package.count({ where: { showDate: toDbDate(NEVER) } }), 0);
  }

  console.log("\n[what-if] A watch file, every order cancelled.");
  {
    const l = "GFUS01990000000015";
    const w = watches("w.csv", WATCH_ALL, 3, "96000032", watchesOn(l));
    await upload(w);
    check("three sales, two boxes", [(await lineSales("WATCH", WATCH_ALL)).length, await prisma.package.count({ where: { showDate: toDbDate(WATCH_ALL) } })], [3, 2]);
    // The shared-label box packed; the single one left open.
    await pack(l, ["W90001", "W90002"]);
    const all = ["960000320000", "960000320001", "960000320002"].reduce((f, id) => cancelled(f, id), { ...w, name: "w2.csv" });
    const cut = await upload(all);
    check("goes in, as that day", [cut.status, cut.showDate, cut.business], ["OK", WATCH_ALL, "WATCH"]);
    check("every sale taken away", await lineSales("WATCH", WATCH_ALL), []);
    check("the unpacked box swept off the floor, the packed one kept", (await prisma.package.findMany({ where: { showDate: toDbDate(WATCH_ALL) }, select: { trackingNumber: true } })).map((b) => b.trackingNumber), [l]);
    check("and the packed parcel is named, to pull", cut.flags.some((f) => f.severity === "warning" && f.message.includes(l)), true);
  }

  console.log("\n[what-if] An eBay report whose only order was refunded, for a day never uploaded.");
  {
    await schedule(EBAY_NONE);
    const refused = await runImport([file(EBAY_NONE, [order(EBAY_NONE, "44001", { total: "$0.00" })])], boss.id);
    if (refused.batchId) await prisma.importBatch.delete({ where: { id: refused.batchId } });
    check("refused", refused.status, "BLOCKED");
    check(
      "and says why — no sale left to tell the day by",
      refused.flags.some((f) => f.severity === "blocking" && f.message.includes("no order in it is a sale")),
      true,
    );
  }

  /* --------- what-ifs from the independent review of the all-cancelled fix, 10/14 */
  const allCancelled = (f: { name: string; text: string }) =>
    ({ name: f.name, text: f.text.replace(/,To ship,Awaiting collection,/g, ",Canceled,,") });
  const lineAt = async (business: "WATCH" | "DIAMOND", d: string, slot: string) => {
    const b = await prisma.importBatch.findFirst({
      where: { business, showDate: toDbDate(d), status: "OK", platform: "TIKTOK", slot },
      orderBy: { uploadedAt: "desc" },
      select: { sales: { select: { orderRef: true } }, drops: { select: { orderRef: true } }, files: true },
    });
    return b && {
      sales: b.sales.map((s) => s.orderRef).sort(),
      drops: b.drops.map((s) => s.orderRef).sort(),
      files: (b.files as { name: string }[]).map((f) => f.name).sort(),
    };
  };
  /** Published TikTok shows on a day, times in UTC. */
  const tiktokShows = async (d: string, business: "WATCH" | "DIAMOND", slots: { slot: string; from: string; to: string }[]) => {
    const r = await prisma.release.create({
      data: { name: `${PREFIX}${business} tt ${d}`, business, startDate: toDbDate(d), endDate: toDbDate(d), scheduleStatus: "PUBLISHED" },
      select: { id: true },
    });
    for (const s of slots) {
      await prisma.show.create({
        data: { releaseId: r.id, business, date: toDbDate(d), platform: "TIKTOK", slot: s.slot, startsAt: new Date(s.from), endsAt: new Date(s.to) },
      });
    }
  };

  console.log("\n[what-if] The day file and an all-cancelled night file in one drop.");
  {
    const day = watches("day.csv", WA_PAIR, 2, "96000041", {});
    const night = watches("night.csv", WA_PAIR, 2, "96000042", { time: "07:05:00 PM" });
    await upload(day);
    await upload(night);
    check("four boxes", await prisma.package.count({ where: { showDate: toDbDate(WA_PAIR) } }), 4);
    const both = await runImport([day, allCancelled({ ...night, name: "night3.csv" })], boss.id);
    check("together: goes in", both.status, "OK");
    check("the day line keeps its sales", (await lineAt("WATCH", WA_PAIR, "DAY"))?.sales, ["960000410000", "960000410001"]);
    check("the night line has no sale, its rows on the exceptions list", await lineAt("WATCH", WA_PAIR, "NIGHT"), {
      sales: [], drops: ["960000420000", "960000420001"], files: ["night3.csv"],
    });
    check("the night's unpacked boxes swept, the day's kept", await prisma.package.count({ where: { showDate: toDbDate(WA_PAIR) } }), 2);
  }

  console.log("\n[what-if] An all-cancelled file that is not the line's own export (a stray, or the Canceled tab).");
  {
    await upload(watches("day.csv", WA_WRONG, 3, "96000043", {}));
    const stray = await runImport([allCancelled(watches("stray.csv", WA_WRONG, 1, "96000044", {}))], boss.id);
    if (stray.status !== "OK" && stray.batchId) await prisma.importBatch.delete({ where: { id: stray.batchId } });
    check("sharing no order with the line: refused", stray.status, "BLOCKED");
    check("saying why", stray.flags.some((f) => f.severity === "blocking" && f.message.includes("not that show's whole export")), true);
    // Only the cancelled one of three: still not the whole export.
    const tab = watches("day.csv", WA_WRONG, 3, "96000043", {});
    const partial = { name: "canceled-tab.csv", text: allCancelled(tab).text.split("\r\n").filter((l, i) => i === 0 || l.includes("960000430001\t")).join("\r\n") };
    const part = await runImport([partial], boss.id);
    if (part.status !== "OK" && part.batchId) await prisma.importBatch.delete({ where: { id: part.batchId } });
    check("only the cancelled order of three: refused", part.status, "BLOCKED");
    check("and the day line keeps its sales", (await lineAt("WATCH", WA_WRONG, "DAY"))?.sales.length, 3);
    check("and its boxes", await prisma.package.count({ where: { showDate: toDbDate(WA_WRONG) } }), 3);
  }

  console.log("\n[what-if] Two diamond shows, the shared whole-day file, then every order cancelled.");
  {
    // Day 10 AM to 4 PM Pacific, night 7 PM on (UTC-7 in June).
    await tiktokShows(DI_WHOLE, "DIAMOND", [
      { slot: "DAY", from: `${DI_WHOLE}T17:00:00Z`, to: `${DI_WHOLE}T23:00:00Z` },
      { slot: "NIGHT", from: "2019-06-24T02:00:00Z", to: "2019-06-24T06:00:00Z" },
    ]);
    const am = diamonds("a.csv", DI_WHOLE, 2, "96000045", {});
    const pm = diamonds("b.csv", DI_WHOLE, 2, "96000046", { time: "08:05:00 PM" });
    const whole = { name: "whole.csv", text: `${am.text}\r\n${pm.text.split("\r\n").slice(1).join("\r\n")}` };
    await upload(whole);
    check("shared: two on the day, two on the night", [
      (await lineAt("DIAMOND", DI_WHOLE, "DAY"))?.sales.length, (await lineAt("DIAMOND", DI_WHOLE, "NIGHT"))?.sales.length,
    ], [2, 2]);
    const out = await upload(allCancelled({ ...whole, name: "whole2.csv" }));
    check("all cancelled: both lines empty", [
      (await lineAt("DIAMOND", DI_WHOLE, "DAY"))?.sales, (await lineAt("DIAMOND", DI_WHOLE, "NIGHT"))?.sales,
    ], [[], []]);
    check("the file on both lines", [
      (await lineAt("DIAMOND", DI_WHOLE, "DAY"))?.files, (await lineAt("DIAMOND", DI_WHOLE, "NIGHT"))?.files,
    ], [["whole2.csv"], ["whole2.csv"]]);
    check("says both shows", out.flags.some((f) => f.message.includes("day and night shows") && f.message.includes("have no sales")), true);
    check("no boxes left", await prisma.package.count({ where: { showDate: toDbDate(DI_WHOLE) } }), 0);
  }

  console.log("\n[what-if] A day with an Early AM show, its file all cancelled.");
  {
    // Early 4 to 10 AM Pacific, day 10 AM to 4 PM, night from 4 PM.
    await tiktokShows(EARLY_D, "WATCH", [
      { slot: "EARLY AM", from: `${EARLY_D}T11:00:00Z`, to: `${EARLY_D}T17:00:00Z` },
      { slot: "DAY", from: `${EARLY_D}T17:00:00Z`, to: `${EARLY_D}T23:00:00Z` },
      { slot: "NIGHT", from: `${EARLY_D}T23:00:00Z`, to: "2019-06-26T05:00:00Z" },
    ]);
    const early = watches("early.csv", EARLY_D, 2, "96000047", { time: "05:10:00 AM" });
    await upload(early);
    await upload(watches("day.csv", EARLY_D, 2, "96000048", {}));
    check("the early file on its own line", (await lineAt("WATCH", EARLY_D, "EARLY AM"))?.sales.length, 2);
    const out = await upload(allCancelled({ ...early, name: "early2.csv" }));
    check("goes in", out.status, "OK");
    check("the early line empty", (await lineAt("WATCH", EARLY_D, "EARLY AM"))?.sales, []);
    check("the day line untouched", (await lineAt("WATCH", EARLY_D, "DAY"))?.sales, ["960000480000", "960000480001"]);
  }

  console.log("\n[what-if] The TikTok file and an eBay report whose only order was refunded, one drop.");
  {
    await schedule(EB_PAIR);
    const tt = watches("tt.csv", EB_PAIR, 1, "96000049", {});
    await upload(tt);
    await upload(file(EB_PAIR, [order(EB_PAIR, "45001")]));
    const out = await runImport([tt, file(EB_PAIR, [order(EB_PAIR, "45001", { total: "$0.00" })])], boss.id);
    check("goes in", out.status, "OK");
    check(
      "and says the eBay report was not changed",
      out.flags.some((f) => f.severity === "warning" && f.message.includes("did not replace the day's eBay report")),
      true,
    );
    // Known, said: the eBay line keeps the order until the day is sorted by hand.
    check("the eBay line as it was", (await day(EB_PAIR)).sales, ["45001"]);
  }

  console.log("\n[what-if] Cancelled and never-paid rows in one file.");
  {
    const f = watches("w.csv", MIXED_NP, 2, "96000050", {});
    await upload(f);
    const rows = f.text.split("\r\n");
    rows[1] = rows[1].replace(",To ship,Awaiting collection,", ",Canceled,,");
    const header = rows[0].replace(/^﻿/, "").split(",");
    const cells = rows[2].split(",");
    cells[header.indexOf("Paid Time")] = "";
    rows[2] = cells.join(",");
    const out = await upload({ name: "w2.csv", text: rows.join("\r\n") });
    check("goes in, saying cancelled or never paid", out.flags.some((x) => x.message.includes("was cancelled or never paid")), true);
    check("the line empty", (await lineAt("WATCH", MIXED_NP, "DAY"))?.sales, []);
  }

  console.log("\n[what-if] Two people at once: the all-cancelled night file and the day file.");
  {
    const day = watches("day.csv", AT_ONCE, 2, "96000051", {});
    const night = watches("night.csv", AT_ONCE, 2, "96000052", { time: "07:05:00 PM" });
    await upload(day);
    await upload(night);
    for (let i = 0; i < 2; i++) {
      const [a, b] = await Promise.all([
        runImport([allCancelled({ ...night, name: `night${i}.csv` })], boss.id),
        runImport([day], boss.id),
      ]);
      check(`at once, round ${i + 1}: both go in`, [a.status, b.status], ["OK", "OK"]);
      check(`round ${i + 1}: night empty, day has its sales`, [
        (await lineAt("WATCH", AT_ONCE, "NIGHT"))?.sales, (await lineAt("WATCH", AT_ONCE, "DAY"))?.sales,
      ], [[], ["960000510000", "960000510001"]]);
    }
  }

  console.log("\n[review] A real \"Canceled\" row rather than a row left out; the corrected file twice.");
  {
    const l = "GFUS01990000000013";
    await upload(watches("w.csv", MIX_CXL, 3, "96000025", watchesOn(l)));
    const d = diamonds("d.csv", MIX_CXL, 2, "96000026", diamondOn(l));
    await upload(d);
    await pack(l, ["W90001", "W90002", "E93557"]);
    const cut = await upload(cancelled({ ...d, name: "d2.csv" }, "960000260000"));
    check("cancelled row: named, take out the diamond", said(cut, l), ["E93557"]);
    const twice = await upload(cancelled({ ...d, name: "d3.csv" }, "960000260000"));
    // Every earlier upload of the line counts as replaced (`supersededIds`), so
    // the label stays "let go of" and the parcel is named again each time —
    // the same as the watch side does (`packedWithExtra`) until it is pulled.
    check("the same corrected file again: still named, once", said(twice, l), ["E93557"]);
    check("the box still untouched", await items(l), ["E93557 1/1", "W90001 1/1", "W90002 1/1"]);
  }

  console.log("\n[review] One label across two watch days, packed, the first day's order cancelled.");
  {
    const l = "GFUS01990000000014";
    const dayA = (name: string, names: string[], tracking: (string | undefined)[]) =>
      watches(name, TWO_DAY_A, names.length, "96000027", { names, tracking, buyer: "buyer.two" });
    const dayB = (name: string) =>
      watches(name, TWO_DAY_B, 2, "96000028", { names: ["W91003", "W91004"], tracking: [l, undefined], buyer: "buyer.two" });
    await upload(dayA("a.csv", ["W91001", "W91002"], [l, undefined]));
    await upload(dayB("b.csv"));
    check("one box with both days", await items(l), ["W91001 0/1", "W91003 0/1"]);
    await pack(l, ["W91001", "W91003"]);
    check("closed", await status(l), "CLOSED_COMPLETE");
    check("day A again: nothing said", said(await upload(dayA("a1.csv", ["W91001", "W91002"], [l, undefined])), l), []);
    const cut = await upload(cancelled(dayA("a2.csv", ["W91001", "W91002"], [l, undefined]), "960000270000"));
    check("day A's piece cancelled: named, take out W91001 only", said(cut, l), ["W91001"]);
    check("day B again after: still named", said(await upload(dayB("b2.csv")), l), ["W91001"]);
  }

  /* ------------------------------- an ordinary re-upload says nothing new */
  const again = await upload(file(SENT, [order(SENT, "43001"), order(SENT, "43002", { total: "$0.00" })]));
  check("the same corrected file again: still no \"pull it\"", again.flags.some((f) => f.message.includes("pull each one")), false);
} finally {
  await clean();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

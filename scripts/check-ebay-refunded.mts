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
const ALL = [
  FIRST, LATER, CLOSED, SHARED, LATE_SOLD, LATE_PAID, SENT,
  MIX_D, MIX_W, MIX_ONE, MIX_ALL, MIX_PH, MIX_SHORT, MIX_SENT, MIX_EBAY,
  MIX_PH_KEEP, MIX_ONLY, MIX_CXL, TWO_DAY_A, TWO_DAY_B,
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
    // Not through `upload`: found 10/14 that a file whose every order is
    // cancelled is refused with no reason and no day, so the cancellation
    // never reaches the day at all. Its refusal is dated 1970 and removed here.
    const cut = await runImport([cancelled({ ...d, name: "d2.csv" }, "960000240000")], boss.id);
    if (cut.status !== "OK" && cut.batchId) await prisma.importBatch.delete({ where: { id: cut.batchId } });
    // Known, not yet fixed (was so before 10/14): the file is refused, so
    // nothing is named. Recorded as it is, so a fix shows up here — then
    // expect "OK" and ["E93557"].
    check("KNOWN GAP — every diamond order cancelled: the upload is refused", cut.status, "BLOCKED");
    check("KNOWN GAP — and so the parcel is not named", said(cut, l), []);
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

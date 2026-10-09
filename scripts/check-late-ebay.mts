/**
 * Late eBay orders, and one drop holding both businesses — against a real
 * database.
 *
 * On 10/01 the 09/30 morning was turned away twice over: the watch and diamond
 * files went up in one drop, and the eBay report held one order sold in the
 * 09/29 night show and paid after midnight. Each of those refused all ~900
 * orders of the day. This runs the situations that came out of it:
 *
 *   - a late order is added to the previous day's eBay report, gets its box on
 *     that day, and is paid to that day's show
 *   - the same morning uploaded again does not add it twice
 *   - two days' reports dropped together are still refused
 *   - a late order for a day with no eBay report yet is left out and named
 *   - a late order sharing a label with today's stays on today, box whole
 *   - a morning report of nothing but late payers joins the day before's
 *   - the day before's report corrected afterwards keeps the late order
 *   - a one-sale report with one late payer, in either row order
 *   - the same all-late file twice, and a corrected all-late day report
 *   - a morning and a corrected day-before uploaded at the same moment
 *   - a late order whose box on the day before is already closed
 *   - watch and diamond TikTok files in one drop go up as two uploads
 *   - 10/09: labels with a date but no show ("AM-PM", "NUEVO") and one order
 *     checked out after midnight: accepted, on the labelled day
 *   - the eBay file alone, for a day whose TikTok is already in: added, TikTok kept
 *   - a morning of late payers plus one blank-label sale of its own day: that
 *     sale is not pulled back onto the day before
 *
 * Every file is synthetic and every date years in the past, so nothing here
 * can touch a real day. It refuses to run against anything but a local
 * database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-late-ebay.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { fromDbDate, toDbDate } from "../src/lib/domain/dates";
import { ebayReport, tiktokReport } from "../src/lib/domain/imports/synthetic-exports";
import { runImport, runImports, splitByBusiness } from "../src/lib/server/imports";
import { latestBatchIds } from "../src/lib/server/sales-data";

assertDevDatabase("check-late-ebay.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`,
  );
  if (!ok) failures++;
}

/* ------------------------------------------------------------- the days */

const BEFORE = "2021-03-10";
const DAY = "2021-03-11";
const EMPTY_BEFORE = "2021-03-20"; // never has an eBay report
const EMPTY_DAY = "2021-03-21";
const CLOSED_BEFORE = "2021-04-10";
const CLOSED_DAY = "2021-04-11";
const BOTH_DAY = "2021-05-05"; // watch and diamond TikTok in one drop
const CHECKOUT_DAY = "2021-06-20"; // an order checked out after midnight
const CHECKOUT_NEXT = "2021-06-21";
const LABEL_DAY = "2021-06-25"; // every label "06.25.21 AM-PM", one order checked out after midnight
const LABEL_NEXT = "2021-06-26";
const LONE_DAY = "2021-06-28"; // TikTok first, the eBay file on its own later
const PAYERS_BEFORE = "2021-07-01"; // a morning of late payers, plus one blank-label sale of its own day
const PAYERS_DAY = "2021-07-02";
const ONLY_LATE_BEFORE = "2021-07-10";
const ONLY_LATE_DAY = "2021-07-11"; // no eBay show: the report is all late payers
const TINY_BEFORE = "2021-08-10";
const TINY_DAY = "2021-08-11";
const SMALL_DAY = "2021-08-20"; // a day whose own report is all paid after midnight
const SMALL_NEXT = "2021-08-21";
// Pairs of days for the side-by-side uploads, one pair per timing.
const RACES = [0, 15, 30, 60, 120].map((offset, i) => ({
  offset,
  before: `2021-10-${String(10 + 2 * i).padStart(2, "0")}`,
  day: `2021-10-${String(11 + 2 * i).padStart(2, "0")}`,
}));
const ALL = [
  BEFORE, DAY, EMPTY_BEFORE, EMPTY_DAY, CLOSED_BEFORE, CLOSED_DAY, BOTH_DAY,
  ONLY_LATE_BEFORE, ONLY_LATE_DAY, TINY_BEFORE, TINY_DAY, SMALL_DAY, SMALL_NEXT, CHECKOUT_DAY, CHECKOUT_NEXT, LABEL_DAY, LABEL_NEXT, LONE_DAY, PAYERS_BEFORE, PAYERS_DAY,
  ...RACES.flatMap((r) => [r.before, r.day]),
];

async function clean() {
  const batches = await prisma.importBatch.findMany({
    where: { showDate: { in: ALL.map(toDbDate) } },
    select: { id: true },
  });
  const ids = batches.map((b) => b.id);
  if (ids.length === 0) return;
  await prisma.package.deleteMany({ where: { batchId: { in: ids }, scans: { none: {} } } });
  await prisma.package.updateMany({ where: { batchId: { in: ids } }, data: { batchId: null } });
  await prisma.importBatch.deleteMany({ where: { id: { in: ids } } });
}

const boss = await prisma.user.findFirstOrThrow({
  where: { role: "BOSS", isActive: true },
  select: { id: true },
});

/** What a day's current eBay report holds, as the readers see it. */
async function ebayOrdersOn(day: string): Promise<string[]> {
  const ids = await latestBatchIds(day as never, day as never);
  const rows = await prisma.salesRecord.findMany({
    where: { batchId: { in: ids }, platform: "EBAY" },
    select: { orderRef: true, showDate: true },
  });
  return [...new Set(rows.filter((r) => fromDbDate(r.showDate) === day).map((r) => r.orderRef))].sort();
}

const messages = (o: { flags: { message: string }[] }) => o.flags.map((f) => f.message).join(" | ");

await clean();

try {
  /* -------------------------------- the ordinary late order, as on 09/30 */

  console.log("A late order is added to the day it sold in.");
  const before = await runImport(
    [
      {
        name: "before.csv",
        text: ebayReport([
          { srn: "101", showDay: BEFORE, paidDay: BEFORE },
          { srn: "102", showDay: BEFORE, paidDay: BEFORE },
        ]),
      },
    ],
    boss.id,
  );
  check("the day before's eBay report goes in", before.status, "OK");

  const morning = {
    name: "morning.csv",
    text: ebayReport([
      { srn: "201", showDay: DAY, paidDay: DAY },
      { srn: "202", showDay: DAY, paidDay: DAY },
      // Sold in the night show the day before, paid after midnight.
      { srn: "103", showDay: BEFORE, paidDay: DAY, price: "$310.00" },
    ]),
  };
  const day = await runImport([morning], boss.id);
  check("the morning's report is no longer refused", day.status, "OK");
  check("it is the morning's day", day.showDate, DAY);
  check("the morning keeps its own two orders", await ebayOrdersOn(DAY), ["201", "202"]);
  check("the late order is on the day it sold", await ebayOrdersOn(BEFORE), ["101", "102", "103"]);
  check("and the screen says so", /103.*added to 2021-03-10's eBay report/.test(messages(day)), true);
  check(
    "the parser's 'two Sale Dates' note is replaced by that",
    /different Sale Dates/.test(messages(day)),
    false,
  );

  const box = await prisma.package.findUnique({
    where: { trackingNumber: "9434608106245552000103" },
    select: { showDate: true, status: true, items: { select: { expectedQty: true } } },
  });
  check("it has a box, on the day it sold", box ? fromDbDate(box.showDate) : null, BEFORE);
  check("with its piece in it", box?.items.map((i) => i.expectedQty), [1]);
  check(
    "the day before's other boxes are still there",
    await prisma.package.count({
      where: { trackingNumber: { in: ["9434608106245552000101", "9434608106245552000102"] } },
    }),
    2,
  );
  check(
    "the earlier version of that report stays on record",
    await prisma.importBatch.count({
      where: { showDate: toDbDate(BEFORE), platform: "EBAY", status: "OK" },
    }),
    2,
  );

  // Paid to the show it sold in: the day before's night eBay.
  const beforeIds = await latestBatchIds(BEFORE as never, BEFORE as never);
  const paidTo = await prisma.salesRecord.groupBy({
    by: ["showDate", "show"],
    where: { batchId: { in: beforeIds } },
    _sum: { netItemPriceCents: true },
  });
  check(
    "its sale counts towards the day before's eBay night show",
    paidTo.map((r) => [fromDbDate(r.showDate), r.show, r._sum.netItemPriceCents]),
    [[BEFORE, "eBay PM", 2_500 + 2_500 + 31_000]],
  );

  /* --------------------------------------- the same morning uploaded again */

  const again = await runImport([morning], boss.id);
  check("uploading the morning again is accepted", again.status, "OK");
  check("and does not add the late order twice", await ebayOrdersOn(BEFORE), ["101", "102", "103"]);
  check(
    "it says the order was already there",
    /103 sold in the 2021-03-10 show and are already in/.test(messages(again)),
    true,
  );
  check(
    "nor makes a second box",
    await prisma.package.count({ where: { trackingNumber: "9434608106245552000103" } }),
    1,
  );

  /* ---------------------------- two days' reports dropped in together */

  const twoDays = await runImport(
    [
      { name: "before-again.csv", text: ebayReport([{ srn: "101", showDay: BEFORE, paidDay: BEFORE }]) },
      { name: "day-again.csv", text: ebayReport([{ srn: "201", showDay: DAY, paidDay: DAY }]) },
    ],
    boss.id,
  );
  check("two whole days in one drop are still refused", twoDays.status, "BLOCKED");
  check("as two show days", /cover 2 different show days/.test(messages(twoDays)), true);

  /* -------------------- a late order for a day with no eBay report at all */

  console.log("\nA late order for a day with nothing loaded.");
  const lonely = await runImport(
    [
      {
        name: "lonely.csv",
        text: ebayReport([
          { srn: "301", showDay: EMPTY_DAY, paidDay: EMPTY_DAY },
          { srn: "302", showDay: EMPTY_BEFORE, paidDay: EMPTY_DAY },
        ]),
      },
    ],
    boss.id,
  );
  check("the morning still goes in", lonely.status, "OK");
  check("with its own order", await ebayOrdersOn(EMPTY_DAY), ["301"]);
  check(
    "nothing is made up for the empty day",
    await prisma.importBatch.count({ where: { showDate: toDbDate(EMPTY_BEFORE) } }),
    0,
  );
  check(
    "and the order is named so somebody looks",
    /302 sold in the 2021-03-20 show.*no Watch eBay report loaded yet/.test(messages(lonely)),
    true,
  );

  /* ---------------------- a late order sharing a label with today's order */

  const shared = await runImport(
    [
      {
        name: "shared.csv",
        text: ebayReport([
          { srn: "401", showDay: EMPTY_DAY, paidDay: EMPTY_DAY, tracking: "9434608106245552999999", buyer: "same_buyer" },
          { srn: "402", showDay: EMPTY_BEFORE, paidDay: EMPTY_DAY, tracking: "9434608106245552999999", buyer: "same_buyer" },
        ]),
      },
    ],
    boss.id,
  );
  check("a shared label does not refuse the morning", shared.status, "OK");
  check(
    "both orders stay on today, so the parcel's box is whole",
    (await ebayOrdersOn(EMPTY_DAY)).filter((o) => o === "401" || o === "402"),
    ["401", "402"],
  );
  check(
    "with both pieces in that one box",
    (
      await prisma.package.findUniqueOrThrow({
        where: { trackingNumber: "9434608106245552999999" },
        select: { items: { select: { stockNumber: true } } },
      })
    ).items.length,
    2,
  );
  check(
    "and the screen says whose commission it becomes",
    /402 sold in the 2021-03-20 show.*kept on 2021-03-21.*commission counts towards 2021-03-21.s eBay PM show/.test(messages(shared)),
    true,
  );

  /* --------------------- a late order whose box the day before is closed */

  console.log("\nA late order for a box already sent.");
  await runImport(
    [
      {
        name: "closed-before.csv",
        text: ebayReport([{ srn: "501", showDay: CLOSED_BEFORE, paidDay: CLOSED_BEFORE }]),
      },
    ],
    boss.id,
  );
  await prisma.package.update({
    where: { trackingNumber: "9434608106245552000501" },
    data: { status: "CLOSED_COMPLETE" },
  });
  const sentAlready = await runImport(
    [
      {
        name: "closed-day.csv",
        text: ebayReport([
          { srn: "601", showDay: CLOSED_DAY, paidDay: CLOSED_DAY },
          // Same buyer, same label, as the order already packed and sent.
          { srn: "502", showDay: CLOSED_BEFORE, paidDay: CLOSED_DAY, tracking: "9434608106245552000501", buyer: "buyer_501" },
        ]),
      },
    ],
    boss.id,
  );
  check("the morning goes in", sentAlready.status, "OK");
  check("the late order is on its day's report", await ebayOrdersOn(CLOSED_BEFORE), ["501", "502"]);
  check(
    "the closed box is left exactly as it was",
    (
      await prisma.package.findUniqueOrThrow({
        where: { trackingNumber: "9434608106245552000501" },
        select: { status: true, items: { select: { stockNumber: true } } },
      })
    ).items.length,
    1,
  );
  check("and the screen says to check it", /was already closed/.test(messages(sentAlready)), true);

  /* --------------- the day before's report corrected after a late order */

  console.log("\nThe day before's report corrected after the late order went in.");
  // 103 was added to BEFORE from the morning report. A fresh download of
  // BEFORE taken before that buyer paid does not have it.
  const corrected = await runImport(
    [
      {
        name: "before-corrected.csv",
        text: ebayReport([
          { srn: "101", showDay: BEFORE, paidDay: BEFORE },
          { srn: "102", showDay: BEFORE, paidDay: BEFORE },
        ]),
      },
    ],
    boss.id,
  );
  check("the correction is accepted", corrected.status, "OK");
  check("and keeps the late order", await ebayOrdersOn(BEFORE), ["101", "102", "103"]);
  check(
    "and its box",
    await prisma.package.count({ where: { trackingNumber: "9434608106245552000103" } }),
    1,
  );
  check("and says so", /Kept eBay order\(s\) 103/.test(messages(corrected)), true);

  // A later download does have it — then it is the file's, not kept twice.
  const withIt = await runImport(
    [
      {
        name: "before-later.csv",
        text: ebayReport([
          { srn: "101", showDay: BEFORE, paidDay: BEFORE },
          { srn: "102", showDay: BEFORE, paidDay: BEFORE },
          { srn: "103", showDay: BEFORE, paidDay: DAY, price: "$310.00" },
        ]),
      },
    ],
    boss.id,
  );
  check("a correction that has the order itself goes in", withIt.status, "OK");
  const beforeRows = await prisma.salesRecord.count({
    where: { batchId: { in: await latestBatchIds(BEFORE as never, BEFORE as never) }, orderRef: "103" },
  });
  check("and holds it once", beforeRows, 1);

  /* -------------------- a morning report of nothing but late payers */

  console.log("\nA morning with no eBay show: the report is all late payers.");
  await runImport(
    [
      {
        name: "only-late-before.csv",
        text: ebayReport([
          { srn: "701", showDay: ONLY_LATE_BEFORE, paidDay: ONLY_LATE_BEFORE },
          { srn: "702", showDay: ONLY_LATE_BEFORE, paidDay: ONLY_LATE_BEFORE },
        ]),
      },
    ],
    boss.id,
  );
  const onlyLate = await runImport(
    [{ name: "only-late.csv", text: ebayReport([{ srn: "703", showDay: ONLY_LATE_BEFORE, paidDay: ONLY_LATE_DAY }]) }],
    boss.id,
  );
  check("it is accepted", onlyLate.status, "OK");
  check(
    "it joins the day before's report instead of replacing it",
    await ebayOrdersOn(ONLY_LATE_BEFORE),
    ["701", "702", "703"],
  );
  check(
    "whose boxes are all still there",
    await prisma.package.count({
      where: {
        trackingNumber: { in: ["9434608106245552000701", "9434608106245552000702", "9434608106245552000703"] },
      },
    }),
    3,
  );
  check(
    "and nothing is made up for the morning's own day",
    await prisma.importBatch.count({ where: { showDate: toDbDate(ONLY_LATE_DAY) } }),
    0,
  );
  const twice = await runImport(
    [{ name: "only-late.csv", text: ebayReport([{ srn: "703", showDay: ONLY_LATE_BEFORE, paidDay: ONLY_LATE_DAY }]) }],
    boss.id,
  );
  check("the same all-late file again is accepted", twice.status, "OK");
  check("and changes nothing", await ebayOrdersOn(ONLY_LATE_BEFORE), ["701", "702", "703"]);
  check("and says the order is already there", /703 sold in the 2021-07-10 show and are already in/.test(messages(twice)), true);

  /* ------------- a day's own report, every buyer paid after midnight, corrected */

  console.log("\nA small day's own report, all paid after midnight, then corrected.");
  const small = await runImport(
    [
      {
        name: "small.csv",
        text: ebayReport([
          { srn: "1001", showDay: SMALL_DAY, paidDay: SMALL_NEXT },
          { srn: "1002", showDay: SMALL_DAY, paidDay: SMALL_NEXT },
        ]),
      },
    ],
    boss.id,
  );
  check("it goes in as that day's report", [small.status, await ebayOrdersOn(SMALL_DAY)], ["OK", ["1001", "1002"]]);
  const smallFixed = await runImport(
    [{ name: "small-corrected.csv", text: ebayReport([{ srn: "1001", showDay: SMALL_DAY, paidDay: SMALL_NEXT }]) }],
    boss.id,
  );
  check("a corrected copy replaces it, as any correction does", [smallFixed.status, await ebayOrdersOn(SMALL_DAY)], ["OK", ["1001"]]);
  check(
    "and the order it no longer has loses its untouched box",
    await prisma.package.count({ where: { trackingNumber: "9434608106245552001002" } }),
    0,
  );

  /* -------------------- a one-sale report with one late payer, either order */

  console.log("\nA one-and-one report.");
  await runImport(
    [{ name: "tiny-before.csv", text: ebayReport([{ srn: "801", showDay: TINY_BEFORE, paidDay: TINY_BEFORE }]) }],
    boss.id,
  );
  for (const [label, orders] of [
    ["late row first", [
      { srn: "802", showDay: TINY_BEFORE, paidDay: TINY_DAY },
      { srn: "901", showDay: TINY_DAY, paidDay: TINY_DAY },
    ]],
    ["late row last", [
      { srn: "901", showDay: TINY_DAY, paidDay: TINY_DAY },
      { srn: "802", showDay: TINY_BEFORE, paidDay: TINY_DAY },
    ]],
  ] as const) {
    const tiny = await runImport([{ name: `tiny-${label}.csv`, text: ebayReport([...orders]) }], boss.id);
    check(`${label}: accepted`, tiny.status, "OK");
    check(`${label}: the morning's own sale`, await ebayOrdersOn(TINY_DAY), ["901"]);
    check(`${label}: the late one on its day`, await ebayOrdersOn(TINY_BEFORE), ["801", "802"]);
  }

  /* ------------- the morning and a corrected day-before, at the same moment */

  console.log("\nTwo uploads touching the same eBay report at once.");
  for (const race of RACES) {
    await runImport(
      [
        {
          name: `race-before-${race.offset}.csv`,
          text: ebayReport([
            { srn: "1101", showDay: race.before, paidDay: race.before },
            { srn: "1102", showDay: race.before, paidDay: race.before },
          ]),
        },
      ],
      boss.id,
    );
    const morningRun = runImport(
      [
        {
          name: `race-morning-${race.offset}.csv`,
          text: ebayReport([
            { srn: "1201", showDay: race.day, paidDay: race.day },
            { srn: "1103", showDay: race.before, paidDay: race.day },
          ]),
        },
      ],
      boss.id,
    );
    await new Promise((r) => setTimeout(r, race.offset));
    // A fresh download of the day before: it has a new order, 1104, and not
    // the late payer 1103.
    const correctionRun = runImport(
      [
        {
          name: `race-corrected-${race.offset}.csv`,
          text: ebayReport([
            { srn: "1101", showDay: race.before, paidDay: race.before },
            { srn: "1102", showDay: race.before, paidDay: race.before },
            { srn: "1104", showDay: race.before, paidDay: race.before },
          ]),
        },
      ],
      boss.id,
    );
    const [m, c] = await Promise.all([morningRun, correctionRun]);
    check(
      `${race.offset} ms apart: both go in and the day before keeps every order`,
      [m.status, c.status, await ebayOrdersOn(race.before)],
      ["OK", "OK", ["1101", "1102", "1103", "1104"]],
    );
  }

  /* ---------------- an order checked out after midnight (10/06, record 37378) */

  console.log("\nAn order won in the night show and checked out after midnight.");
  const checkout = await runImport(
    [
      {
        name: "checkout.csv",
        text: ebayReport([
          { srn: "1301", showDay: CHECKOUT_DAY, paidDay: CHECKOUT_DAY },
          { srn: "1302", showDay: CHECKOUT_DAY, paidDay: CHECKOUT_DAY },
          // Tagged with the night show it sold in, dated by eBay the next day.
          { srn: "1303", showDay: CHECKOUT_DAY, saleDay: CHECKOUT_NEXT, paidDay: CHECKOUT_NEXT },
        ]),
      },
    ],
    boss.id,
  );
  check("the report is no longer refused", checkout.status, "OK");
  check("the order is on the show its tag names", await ebayOrdersOn(CHECKOUT_DAY), ["1301", "1302", "1303"]);
  check("nothing is made up for the next day", await prisma.importBatch.count({ where: { showDate: toDbDate(CHECKOUT_NEXT) } }), 0);
  check("and the screen says why", /1303 were checked out after midnight/.test(messages(checkout)), true);

  const wrongTag = await runImport(
    [
      {
        name: "checkout-wrong.csv",
        text: ebayReport([
          { srn: "1311", showDay: CHECKOUT_DAY, paidDay: CHECKOUT_DAY },
          // Dated the next day and tagged the next day: a sale of another day, still refused.
          { srn: "1312", showDay: CHECKOUT_NEXT, paidDay: CHECKOUT_NEXT },
        ]),
      },
    ],
    boss.id,
  );
  check("an order really of the next day is still refused", wrongTag.status, "BLOCKED");

  /* ------------- 10/09: labels with a date but no show, a checkout after midnight */

  console.log("\nLabels like 10.08.26 AM-PM, and one order checked out after midnight.");
  const labelled = await runImport(
    [
      {
        name: "labels.csv",
        text: ebayReport([
          ...Array.from({ length: 12 }, (_, i) => ({
            srn: String(1401 + i), showDay: LABEL_DAY, paidDay: LABEL_DAY, label: i % 2 ? "06.25.21 AM-PM" : "06.25.21 NUEVO",
          })),
          { srn: "1420", showDay: LABEL_DAY, saleDay: LABEL_NEXT, paidDay: LABEL_NEXT, label: "06.25.21 AM-PM" },
        ]),
      },
    ],
    boss.id,
  );
  check("the report goes in", labelled.status, "OK");
  check("the late order is on the day its label names", (await ebayOrdersOn(LABEL_DAY)).includes("1420"), true);
  check("nothing is made up for the next day", await prisma.importBatch.count({ where: { showDate: toDbDate(LABEL_NEXT) } }), 0);

  console.log("\nLate payers from the day before, and one blank-label sale of the morning's own day.");
  await runImport([{ name: "payers-before.csv", text: ebayReport([1, 2, 3].map((i) => ({ srn: String(1600 + i), showDay: PAYERS_BEFORE, paidDay: PAYERS_BEFORE }))) }], boss.id);
  const payers = await runImport(
    [
      {
        name: "payers.csv",
        text: ebayReport([
          ...Array.from({ length: 10 }, (_, i) => ({ srn: String(1610 + i), showDay: PAYERS_BEFORE, paidDay: PAYERS_DAY, label: "" })),
          { srn: "1630", showDay: PAYERS_DAY, paidDay: PAYERS_DAY, label: "" },
        ]),
      },
    ],
    boss.id,
  );
  check("the payers' morning goes in", payers.status, "OK");
  check("its own sale stays on its own day", await ebayOrdersOn(PAYERS_DAY), ["1630"]);
  check("the late payers join the day before", (await ebayOrdersOn(PAYERS_BEFORE)).filter((o) => o >= "1610").length, 10);

  /* ----------------------- the eBay file on its own, TikTok already in */

  console.log("\nThe eBay file on its own, for a day whose TikTok is already in.");
  const tt = await runImport([{ name: "lone-tiktok.csv", text: tiktokReport("vaultshowlive", LONE_DAY, 3, "57800001") }], boss.id);
  const lone = await runImport([{ name: "lone-ebay.csv", text: ebayReport([{ srn: "1501", showDay: LONE_DAY, paidDay: LONE_DAY }, { srn: "1502", showDay: LONE_DAY, paidDay: LONE_DAY }]) }], boss.id);
  check("both go in", [tt.status, lone.status], ["OK", "OK"]);
  const loneIds = await latestBatchIds(LONE_DAY as never, LONE_DAY as never);
  check(
    "the day reads both: the TikTok sales are kept",
    (await prisma.importBatch.findMany({ where: { id: { in: loneIds } }, select: { platform: true, _count: { select: { sales: true } } }, })).map((b) => [b.platform, b._count.sales]).sort(),
    [["EBAY", 2], ["TIKTOK", 3]],
  );
  check("and every box of both", await prisma.package.count({ where: { showDate: toDbDate(LONE_DAY) } }), 5);

  /* ------------------------------ watches and diamonds in a single drop */

  console.log("\nWatch and diamond files in one drop.");
  const watchFile = { name: "watch-tiktok.csv", text: tiktokReport("vaultshowlive", BOTH_DAY, 3, "57700001") };
  const diamondFile = { name: "diamond-tiktok.csv", text: tiktokReport("caratclublive", BOTH_DAY, 2, "57700002") };
  check(
    "they are split by the shop each names",
    splitByBusiness([diamondFile, watchFile]).map((g) => g.map((f) => f.name)),
    [["watch-tiktok.csv"], ["diamond-tiktok.csv"]],
  );
  const both = await runImports([diamondFile, watchFile], boss.id);
  check("each half goes in", both.map((o) => [o.business, o.status, o.watchCount]), [
    ["WATCH", "OK", 3],
    ["DIAMOND", "OK", 2],
  ]);
  check(
    "as one upload per business",
    (
      await prisma.importBatch.findMany({
        where: { showDate: toDbDate(BOTH_DAY), status: "OK" },
        select: { business: true },
        orderBy: { business: "asc" },
      })
    ).map((b) => b.business),
    ["WATCH", "DIAMOND"],
  );
  check(
    "files from one business are not split at all",
    splitByBusiness([watchFile, morning]).length,
    1,
  );
} finally {
  console.log("\nCleaning up.");
  await clean();
  const left = await prisma.importBatch.count({ where: { showDate: { in: ALL.map(toDbDate) } } });
  console.log(`Removed — ${left} fixture upload(s) left.`);
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll late-order checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

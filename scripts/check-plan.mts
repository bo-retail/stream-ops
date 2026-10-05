/**
 * Inventory step 5 — the day's plan and its upload files — against a real
 * database.
 *
 * The situations it will meet, run rather than reasoned about:
 *
 *   - an ordinary morning: the suggestion, saved, the three files made and
 *     read back (one eBay row per unit with its show tag, set price at TP,
 *     TikTok one row per model with what is left)
 *   - a model not ready for TikTok (no box size) or for eBay (no profile)
 *   - yesterday's report not uploaded: named; a diamond report does not count
 *     for watches, and diamond sales do not count as watch sales
 *   - the one watch put on two shows, a mistyped number: refused, nothing saved
 *   - two people saving at once, from the same screen or both first: one is
 *     refused, nothing is overwritten
 *   - the shelf changing after the save (a giveaway, a late report): the files
 *     list only what is there, PM cut first, and the page says so
 *   - a model's eBay profile removed after the save: off eBay, onto TikTok
 *   - a description with & and < in it: the file still opens
 *   - a day with no shows on the schedule: nothing suggested, a plan by hand
 *     still works
 *   - files asked for before a plan is saved: refused
 *   - saving again replaces the plan; the old one stays in the audit log
 *
 * Every model it makes starts ZZTEST-; it plans days in 2099; all of it is
 * removed at the end.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-plan.mts
 */
import "dotenv/config";
import ExcelJS from "exceljs";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, toDbDate } from "../src/lib/domain/dates";
import type { PlanChoice } from "../src/lib/domain/show-plan";
import { saveCount } from "../src/lib/server/inventory";
import { saveAdjustments } from "../src/lib/server/movements";
import { getPlanDay, planFile, releaseFile, savePlan } from "../src/lib/server/show-plan";

assertDevDatabase("check-plan.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const P = "ZZTEST-";
const A = `${P}PLAN-A`, B = `${P}PLAN-B`, C = `${P}PLAN-C`, D = `${P}PLAN-D`;
const DAY = "2099-03-10", QUIET = "2099-03-20";
const boss = await prisma.user.findFirst({ where: { role: "BOSS", isActive: true }, select: { id: true } });
const other = await prisma.user.findFirst({ where: { isActive: true, NOT: { role: "BOSS" } }, select: { id: true } });
if (!boss) {
  console.log("SKIP  needs an admin account. Run the seed first.");
  await prisma.$disconnect();
  process.exit(0);
}
const second = other?.id ?? boss.id;

async function cleanUp() {
  const products = (await prisma.product.findMany({ where: { model: { startsWith: `${P}PLAN-` } }, select: { id: true } })).map((p) => p.id);
  const plans = (await prisma.showPlan.findMany({ where: { date: { gte: toDbDate("2099-01-01") } }, select: { id: true } })).map((p) => p.id);
  const entries = (await prisma.stockMove.findMany({ where: { productId: { in: products } }, select: { entryId: true } })).map((m) => m.entryId);
  await prisma.showPlanLine.deleteMany({ where: { OR: [{ planId: { in: plans } }, { productId: { in: products } }] } });
  await prisma.showPlan.deleteMany({ where: { id: { in: plans } } });
  await prisma.stockMove.deleteMany({ where: { productId: { in: products } } });
  await prisma.stockEntry.deleteMany({ where: { id: { in: entries } } });
  await prisma.importBatch.deleteMany({ where: { files: { equals: [{ name: "ZZTEST" }] } } });
  await prisma.release.deleteMany({ where: { name: { startsWith: "ZZTEST plan" } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...products, ...plans, ...entries, DAY, QUIET] } } });
  await prisma.product.deleteMany({ where: { id: { in: products } } });
}

/** A day's shows, as a release would hold them. */
async function shows(date: string, list: [("TIKTOK" | "EBAY"), ("DAY" | "NIGHT")][], scheduleStatus: "PUBLISHED" | "DRAFT" = "PUBLISHED") {
  await prisma.release.create({
    data: {
      name: `ZZTEST plan ${date}`, startDate: toDbDate(date), endDate: toDbDate(date), status: "CLOSED", scheduleStatus,
      shows: {
        create: list.map(([platform, slot]) => ({
          date: toDbDate(date), platform, slot,
          startsAt: new Date(`${date}T${slot === "DAY" ? "16" : "23"}:00:00.000Z`),
          endsAt: new Date(`${date}T${slot === "DAY" ? "22" : "23"}:59:00.000Z`),
        })),
      },
    },
  });
}

/** One uploaded report with sales of these models. */
async function report(business: "WATCH" | "DIAMOND", date: string, platform: "TIKTOK" | "EBAY", slot: "DAY" | "NIGHT" | null, sold: [string, number][]) {
  await prisma.importBatch.create({
    data: {
      business, showDate: toDbDate(date), platform, slot, files: [{ name: "ZZTEST" }], flags: [],
      sales: {
        create: sold.map(([model, qty], i) => ({
          business, platform, show: `${platform === "EBAY" ? "eBay" : "TikTok"} AM`, showDate: toDbDate(date), shiftTag: "", rawShiftTag: "",
          orderRef: `ZZ-PLAN-${business}-${i}`, lineRef: "1", buyer: "", stockNumber: model, qty, sourceFile: "ZZTEST",
        })),
      },
    },
  });
}

async function readBack(bytes: Uint8Array, sheet: string, from: number) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(sheet)!;
  const rows: (string | number | null)[][] = [];
  ws.eachRow((row, n) => {
    if (n >= from) rows.push((row.values as (string | number | null)[]).slice(1));
  });
  return rows;
}

const choices = (list: [string, number, number, boolean][]): PlanChoice[] => list.map(([model, AM, PM, setPrice]) => ({ model, AM, PM, setPrice }));

try {
  await cleanUp();

  // Four watches: A and B ready for both; C has no box size (no TikTok); D has
  // no eBay profile. B's TP is $150, so it runs at a set price by default.
  const base = {
    imageUrl: "https://trade.invictawatch.com/zz.jpg", costCents: 2_000, tpCents: 6_000, weightLb: 0.8, lengthIn: 6, widthIn: 6, heightIn: 6,
    ebayShippingProfile: "eBay Live Shipping Policy Small",
  };
  await prisma.product.createMany({
    data: [
      { model: A, description: "INVICTA Pro Diver & <Bolt> Men 42mm", ...base },
      { model: B, description: "INVICTA Reserve", ...base, tpCents: 15_000 },
      { model: C, description: "INVICTA Subaqua", ...base, lengthIn: null },
      { model: D, description: "INVICTA Angel", ...base, ebayShippingProfile: "" },
    ],
  });
  const counted = await saveCount(boss.id, [
    { model: A, counted: { SELLABLE: 10 } }, { model: B, counted: { SELLABLE: 4 } },
    { model: C, counted: { SELLABLE: 6 } }, { model: D, counted: { SELLABLE: 2 } },
  ], "check-plan");
  check("the four watches are counted in", counted.ok, true);

  await shows(addDays(DAY, -1), [["TIKTOK", "DAY"], ["EBAY", "NIGHT"]]);
  await shows(DAY, [["EBAY", "DAY"], ["EBAY", "NIGHT"], ["TIKTOK", "DAY"], ["TIKTOK", "NIGHT"]]);
  // Yesterday: the watch TikTok AM report is in (2 of A sold); the eBay one is
  // not — only a diamond eBay report, which must not count for watches.
  await report("WATCH", addDays(DAY, -1), "TIKTOK", "DAY", [[A, 2]]);
  await report("DIAMOND", addDays(DAY, -1), "EBAY", null, [[A, 5]]);
  // A random-pull line naming two watches counts one each; a draft schedule
  // for the quiet day is not the day's schedule yet.
  await report("WATCH", addDays(DAY, -2), "TIKTOK", "NIGHT", []);
  await prisma.salesRecord.create({
    data: {
      batchId: (await prisma.importBatch.findFirst({ where: { showDate: toDbDate(addDays(DAY, -2)), files: { equals: [{ name: "ZZTEST" }] } } }))!.id,
      business: "WATCH", platform: "TIKTOK", show: "TikTok PM", showDate: toDbDate(addDays(DAY, -2)), shiftTag: "", rawShiftTag: "",
      orderRef: "ZZ-PLAN-RP", lineRef: "1", buyer: "", stockNumber: "#300 - Invicta Random Pulls", modelNumber: `${B};${C}`, qty: 2, sourceFile: "ZZTEST",
    },
  });
  await shows(QUIET, [["EBAY", "DAY"], ["EBAY", "NIGHT"]], "DRAFT");
  await shows(addDays(QUIET, -1), [["TIKTOK", "NIGHT"]], "DRAFT");

  /* ---------------------------------------------------- an ordinary morning */
  let day = await getPlanDay(DAY);
  const mine = (models: string[]) => day.rows.filter((r) => models.includes(r.model));
  check("the shelf this morning", mine([A, B, C, D]).map((r) => [r.model, r.available]), [[A, 10], [B, 4], [C, 6], [D, 2]]);
  check("both eBay shows are on the schedule", day.shows, { AM: true, PM: true });
  check("yesterday's missing watch eBay report is named (the diamond one does not count)", day.missingReports, ["eBay"]);
  check("last week's watch sales only (diamond sales of the same number left out)", day.rows.find((r) => r.model === A)!.soldLast7, 2);
  check("a random pull naming two watches counts one of each", [B, C].map((m) => day.rows.find((r) => r.model === m)!.soldLast7), [1, 1]);
  check("not ready: C for TikTok, D for eBay", mine([C, D]).map((r) => [r.missingTiktok, r.missingEbay]), [[["box size"], []], [[], ["eBay shipping profile"]]]);
  check("the suggestion: at most half on eBay, split AM/PM; nothing for D", [A, B, C, D].map((m) => day.proposal[m] ?? null), [
    { AM: 3, PM: 2 }, { AM: 1, PM: 1 }, { AM: 2, PM: 1 }, null,
  ]);
  check("no files before a plan is saved", await planFile(boss.id, DAY, "tiktok"), null);

  const suggestion = day.rows.map((r) => ({ model: r.model, AM: day.proposal[r.model]?.AM ?? 0, PM: day.proposal[r.model]?.PM ?? 0, setPrice: r.model === B }));
  const first = await savePlan(boss.id, DAY, null, suggestion);
  check("the suggestion saves", first.ok && first.version, 1);

  const am = (await planFile(boss.id, DAY, "ebay-am"))!;
  const amRows = await readBack(am.bytes, "Listings", 5);
  check("eBay AM file: one row per unit, named for the show", [am.name, am.rows, amRows.length], ["eBay upload 03.10.99 AM.xlsx", 6, 6]);
  check("eBay AM rows carry the show tag, the model, $1 or the TP", amRows.map((r) => [r[1], r[4], r[9]]), [
    ["03.10.99 AM", A, 1], ["03.10.99 AM", A, 1], ["03.10.99 AM", A, 1], ["03.10.99 AM", B, 150], ["03.10.99 AM", C, 1], ["03.10.99 AM", C, 1],
  ]);
  check("a description with & and < reads back as typed", amRows[0][14], "INVICTA Pro Diver & <Bolt> Men 42mm");
  const tt = (await planFile(boss.id, DAY, "tiktok"))!;
  const ttRows = await readBack(tt.bytes, "Template", 7);
  check("TikTok file: one row per model, what is left; C held (no box size); B starts at its TP", ttRows.map((r) => [r[2], r[10], r[12]]), [
    [A, 5, 1], [B, 2, 150], [D, 2, 1],
  ]);
  check("TikTok's own example row is still row 6 of the file", (await readBack(tt.bytes, "Template", 6))[0][2], "Women's Evening Dress, Luxury, One-shoulder");
  const ttAgain = (await planFile(boss.id, DAY, "tiktok"))!;
  check("downloading a file again gives the same file", [ttAgain.again, (await readBack(ttAgain.bytes, "Template", 7)).map((r) => [r[2], r[10]])], [true, [[A, 5], [B, 2], [D, 2]]]);
  // Two files are out now. Free them (they were "not uploaded") so the plan can be worked on.
  check("a file not uploaded can be freed", [(await releaseFile(boss.id, DAY, "AM")).ok, (await releaseFile(boss.id, DAY, "tiktok")).ok], [true, true]);
  check("…and freeing it twice says so", (await releaseFile(boss.id, DAY, "AM")).ok, false);

  /* ----------------------------------------------------------- refusals */
  const twice = await savePlan(boss.id, DAY, 1, choices([[A, 10, 1, false]]));
  check("the one watch on two shows is refused", twice.ok ? "saved" : twice.problems[0].includes("only 10 on the shelf"), true);
  const typo = await savePlan(boss.id, DAY, 1, choices([[A, NaN, 0, false]]));
  check("a mistyped number is refused", typo.ok, false);
  const notReady = await savePlan(boss.id, DAY, 1, choices([[D, 1, 0, false]]));
  check("eBay for a model with no eBay profile is refused", notReady.ok, false);
  check("nothing refused was saved (still version 1)", (await prisma.showPlan.findFirst({ where: { date: toDbDate(DAY) } }))!.version, 1);

  /* ---------------------------------------------------- two people at once */
  const y = await savePlan(second, DAY, 1, choices([[A, 4, 4, false]]));
  const x = await savePlan(boss.id, DAY, 1, choices([[A, 1, 0, false]]));
  check("the second save from an old screen is refused", [y.ok, x.ok], [true, false]);
  check("…and the first one's plan stands", (await getPlanDay(DAY)).current.find((l) => l.model === A), { model: A, AM: 4, PM: 4, setPrice: false, tiktok: 2 });
  const both = await Promise.all([
    savePlan(boss.id, "2099-03-11", null, choices([[A, 1, 0, false]])),
    savePlan(second, "2099-03-11", null, choices([[A, 2, 0, false]])),
  ]);
  check("two first saves of the same day at once: exactly one saved", both.filter((r) => r.ok).length, 1);
  const audit = await prisma.auditLog.findFirst({ where: { action: "SHOW_PLAN_CHANGED" }, orderBy: { createdAt: "desc" }, select: { before: true } });
  check("saving again keeps the old plan in the audit log", Array.isArray(audit?.before), true);

  /* --------------------------------------------- the shelf changes after */
  // A is planned 4 AM + 4 PM of 10. Five go out as a giveaway: 5 left.
  const gone = await saveAdjustments(boss.id, [{ model: A, qty: -5, place: "SELLABLE", reason: "Giveaway", note: "check-plan" }], "check-plan");
  check("five of A given away", gone.ok, true);
  day = await getPlanDay(DAY);
  check("the files take what is there: PM cut first", day.current.find((l) => l.model === A), { model: A, AM: 4, PM: 1, setPrice: false, tiktok: 0 });
  check("…and the page says so", day.cuts.some((c) => c.includes(A) && c.includes("only 5 on the shelf")), true);
  const pm = (await planFile(boss.id, DAY, "ebay-pm"))!;
  check("the PM file lists only the one left for it", (await readBack(pm.bytes, "Listings", 5)).filter((r) => r[4] === A).length, 1);

  await prisma.product.update({ where: { model: A }, data: { ebayShippingProfile: "" } });
  day = await getPlanDay(DAY);
  check("A's eBay profile removed: off the AM (not out yet); the PM file already out keeps its 1; TikTok the other 4", day.current.find((l) => l.model === A), { model: A, AM: 0, PM: 1, setPrice: false, tiktok: 4 });
  check("…the eBay AM file no longer has it", (await readBack((await planFile(boss.id, DAY, "ebay-am"))!.bytes, "Listings", 5)).filter((r) => r[4] === A).length, 0);

  /* ------------------------------------------ files already downloaded */
  // Fresh: the files above freed, A back to its eBay profile and 10 on the shelf; plan AM 3, PM 3.
  await releaseFile(boss.id, DAY, "AM");
  await releaseFile(boss.id, DAY, "PM");
  await prisma.product.update({ where: { model: A }, data: { ebayShippingProfile: "eBay Live Shipping Policy Small" } });
  await saveCount(boss.id, [{ model: A, counted: { SELLABLE: 10 } }], "check-plan");
  let v = (await prisma.showPlan.findFirst({ where: { date: toDbDate(DAY) } }))!.version;
  check("plan A at 3 AM, 3 PM", (await savePlan(boss.id, DAY, v, choices([[A, 3, 3, false]]))).ok, true);
  v++;
  await planFile(boss.id, DAY, "ebay-am");
  const resave = await savePlan(boss.id, DAY, v, choices([[A, 0, 0, false]]));
  check("after the AM file is out, its numbers cannot change", resave.ok ? "saved" : resave.problems[0].includes("AM eBay file is already out"), true);
  check("…and the TikTok file leaves the AM's 3 out: 3 AM + 3 PM + 4 TikTok = 10", (await getPlanDay(DAY)).current.find((l) => l.model === A), { model: A, AM: 3, PM: 3, setPrice: false, tiktok: 4 });
  await prisma.product.update({ where: { model: A }, data: { ebayShippingProfile: "" } });
  check("eBay profile removed after the AM file is out: AM stays 3, PM off, TikTok 7", (await getPlanDay(DAY)).current.find((l) => l.model === A), { model: A, AM: 3, PM: 0, setPrice: false, tiktok: 7 });
  await prisma.product.update({ where: { model: A }, data: { ebayShippingProfile: "eBay Live Shipping Policy Small" } });
  const ttOut = (await planFile(boss.id, DAY, "tiktok"))!;
  check("the TikTok file then carries 4", (await readBack(ttOut.bytes, "Template", 7)).filter((r) => r[2] === A).map((r) => r[10]), [4]);
  // Two are given away after the AM and TikTok files are out: 8 on the shelf, 3 + 4 out.
  await saveAdjustments(boss.id, [{ model: A, qty: -2, place: "SELLABLE", reason: "Giveaway", note: "check-plan" }], "check-plan");
  day = await getPlanDay(DAY);
  check("the shelf drops after files are out: only the PM (not out yet) is cut, to 1", day.current.find((l) => l.model === A), { model: A, AM: 3, PM: 1, setPrice: false, tiktok: 4 });
  const pmNow = (await planFile(boss.id, DAY, "ebay-pm"))!;
  check("…the PM file lists 1: 3 + 1 + 4 = the 8 on the shelf", (await readBack(pmNow.bytes, "Listings", 5)).filter((r) => r[4] === A).length, 1);
  await saveAdjustments(boss.id, [{ model: A, qty: -3, place: "SELLABLE", reason: "Giveaway", note: "check-plan" }], "check-plan");
  day = await getPlanDay(DAY);
  check("all three out and the shelf drops to 5: told to take 3 down by hand", day.overListed.some((o) => o.includes(A) && o.includes("Take 3 down")), true);
  const cur = day.current;
  v = (await prisma.showPlan.findFirst({ where: { date: toDbDate(DAY) } }))!.version;
  const keepOut = cur.map((l) => ({ model: l.model, AM: l.AM, PM: l.PM, setPrice: l.setPrice }));
  const otherChange = await savePlan(boss.id, DAY, v, keepOut.map((c) => (c.model === B ? { ...c, setPrice: false } : c)));
  check("…and the rest of the plan can still be saved (a change to another model)", otherChange.ok || otherChange.problems, true);
  // B is in the TikTok file out at a set price ($150). Changed to $1 now, the TikTok file downloaded again still starts it at $150.
  const ttAgain2 = (await planFile(boss.id, DAY, "tiktok"))!;
  check("downloading again after a price change gives the same prices", [ttAgain2.again, (await readBack(ttAgain2.bytes, "Template", 7)).filter((r) => r[2] === B).map((r) => r[12])], [true, [150]]);

  /* --------------------------------------------- a day with no shows */
  const quiet = await getPlanDay(QUIET);
  check("a day whose shows are only on a draft schedule: nothing suggested", [quiet.shows, Object.keys(quiet.proposal).filter((m) => m.startsWith(P)).length], [{ AM: false, PM: false }, 0]);
  check("…and no report waited for from a draft schedule", quiet.missingReports, []);
  const byHand = await savePlan(boss.id, QUIET, null, choices([[B, 0, 2, true]]));
  check("…a plan by hand still saves and makes its file", byHand.ok && (await planFile(boss.id, QUIET, "ebay-pm"))!.rows, 2);
} finally {
  await cleanUp();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll passed." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);

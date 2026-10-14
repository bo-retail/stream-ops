/**
 * Extra eBay shows, situation by situation, against a real database. Written by
 * the independent reviewer on 10/14 and kept so every case runs on every change
 * after: label = date + show name ("10.15.26 Early AM"); AM/PM/TT/AM-PM/NUEVO
 * labels as before; late payers, late checkouts and kept-on-today late payers;
 * stale and ahead labels; diamonds; mistyped names. Refuses anything but a local
 * database, and removes everything it made.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-ebay-extra-shows.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { ebayReport } from "../src/lib/domain/imports/synthetic-exports";
import type { EbayOrder } from "../src/lib/domain/imports/synthetic-exports";
import { runImport } from "../src/lib/server/imports";
import { getPayrollPeriod } from "../src/lib/server/payroll";
import { tagShowWords } from "../src/lib/domain/imports/types";

assertDevDatabase("check-ebay-extra-shows.mts");

const PREFIX = "whatif: ebay extra ";
const D = {
  ORD: "2020-03-02", TWICE: "2020-03-04", TYPO: "2020-03-06", NOSHOW: "2020-03-08",
  LATE1: "2020-03-10", LATE2: "2020-03-11", CANC: "2020-03-13", TTONLY: "2020-03-15", DIA: "2020-03-17",
  CHK: "2020-03-19", HIJ: "2020-03-21",
  STALE1: "2020-04-02", STALE2: "2020-04-03", AHEAD1: "2020-04-06", AHEAD2: "2020-04-07", ORDTOK: "2020-04-10", DIATOK: "2020-04-13", KT1: "2020-04-16", KT2: "2020-04-17",
};
const ALL = Object.values(D);
const rows: string[] = [];
function record(sit: string, expected: string, actual: unknown, pass: boolean) {
  rows.push(`${pass ? "PASS" : "FAIL"} | ${sit} | expected: ${expected} | actual: ${JSON.stringify(actual)}`);
}

async function clean() {
  const days = { showDate: { in: ALL.map(toDbDate) } };
  await prisma.scanEvent.deleteMany({ where: { package: days } });
  await prisma.packageItem.deleteMany({ where: { package: days } });
  await prisma.package.deleteMany({ where: days });
  await prisma.importBatch.deleteMany({ where: days });
  await prisma.release.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

const boss = await prisma.user.findFirstOrThrow({ where: { role: "BOSS", isActive: true }, select: { id: true } });
const streamers = await prisma.user.findMany({ where: { isActive: true, team: "STREAMING" }, select: { id: true }, orderBy: { name: "asc" }, take: 2 });

async function schedule(day: string, shows: { slot: string; platform: "TIKTOK" | "EBAY"; cancelled?: boolean }[], business: "WATCH" | "DIAMOND" = "WATCH") {
  const rel = await prisma.release.create({
    data: { name: `${PREFIX}${day}${business}`, business, startDate: toDbDate(day), endDate: toDbDate(day), scheduleStatus: "PUBLISHED" },
    select: { id: true },
  });
  for (const s of shows) {
    const show = await prisma.show.create({
      data: {
        releaseId: rel.id, business, date: toDbDate(day), platform: s.platform, slot: s.slot,
        status: s.cancelled ? "CANCELLED" : "SCHEDULED",
        startsAt: new Date(`${day}T12:00:00Z`), endsAt: new Date(`${day}T14:00:00Z`),
      },
      select: { id: true },
    });
    await prisma.assignment.createMany({ data: streamers.map((p, i) => ({ showId: show.id, userId: p.id, seat: i + 1 })) });
  }
}

const tag = (day: string) => `${day.slice(5, 7)}.${day.slice(8, 10)}.${day.slice(2, 4)}`;
const ebay = (name: string, orders: EbayOrder[], seller?: string) => {
  let text = ebayReport(orders);
  if (seller) text = text.replace("Seller ID : vaultshowofficial", `Seller ID : ${seller}`);
  return { name, text };
};
const simple = (day: string, labels: string[], base: number): EbayOrder[] =>
  labels.map((label, i) => ({ srn: String(base + i), showDay: day, paidDay: day, label }));

async function byShow(day: string, business = "WATCH") {
  const b = await prisma.importBatch.findFirst({
    where: { business: business as "WATCH", status: "OK", showDate: toDbDate(day), platform: "EBAY" },
    orderBy: { uploadedAt: "desc" }, select: { id: true },
  });
  if (!b) return {};
  const rs = await prisma.salesRecord.findMany({ where: { batchId: b.id }, select: { show: true } });
  const out: Record<string, number> = {};
  for (const r of rs) out[r.show] = (out[r.show] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}
const warned = (o: { flags: { severity: string; message: string }[] }, s: string) => o.flags.some((f) => f.message.includes(s));
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

await clean();
try {
  // 1 ordinary day
  await schedule(D.ORD, [{ slot: "EARLY AM", platform: "EBAY" }, { slot: "DAY", platform: "EBAY" }, { slot: "NIGHT", platform: "EBAY" }]);
  const t = tag(D.ORD);
  const o1 = await runImport([ebay("ord.csv", simple(D.ORD, [`${t} Early AM`, `${t} AM`, `${t} PM`, `${t} TT AM`, `${t} AM-PM`, `${t} NUEVO`], 1000))], boss.id);
  const s1 = await byShow(D.ORD);
  record("1 ordinary eBay day w/ Early AM + AM/PM/TT AM/AM-PM/NUEVO", "EARLY AM 1, AM 2, PM 3 (AM-PM, NUEVO -> PM w/ warning)", { status: o1.status, s1 }, o1.status === "OK" && eq(s1, { "eBay AM": 2, "eBay EARLY AM": 1, "eBay PM": 3 }));
  const pay = await getPayrollPeriod(D.ORD, D.ORD);
  const early = pay.shows.find((s) => s.key.platform === "EBAY" && s.key.slot === "EARLY AM");
  record("1b payroll", "Early AM pair paid on $25, nothing unattributed", { cents: early?.netRevenueCents, people: early?.people.length, un: pay.unattributed.length }, early?.netRevenueCents === 2500 && early?.people.length === 2 && pay.unattributed.length === 0);

  // 2 same file twice, then corrected
  await schedule(D.TWICE, [{ slot: "EARLY AM", platform: "EBAY" }, { slot: "DAY", platform: "EBAY" }]);
  const t2 = tag(D.TWICE);
  const f2 = ebay("twice.csv", simple(D.TWICE, [`${t2} Early AM`, `${t2} Early AM`, `${t2} AM`], 1100));
  await runImport([f2], boss.id);
  const o2b = await runImport([f2], boss.id);
  const s2 = await byShow(D.TWICE);
  record("2 same file twice", "EARLY AM 2, AM 1 (no doubling)", { status: o2b.status, s2 }, eq(s2, { "eBay AM": 1, "eBay EARLY AM": 2 }));
  const f2c = ebay("twice-corrected.csv", simple(D.TWICE, [`${t2} Early AM`, `${t2} AM`, `${t2} AM`], 1100));
  const o2c = await runImport([f2c], boss.id);
  const s2c = await byShow(D.TWICE);
  record("2b corrected file (one label fixed Early AM->AM)", "EARLY AM 1, AM 2", { status: o2c.status, s2c }, eq(s2c, { "eBay AM": 2, "eBay EARLY AM": 1 }));

  // 3 typo / blank / Excel-damaged
  await schedule(D.TYPO, [{ slot: "EARLY AM", platform: "EBAY" }, { slot: "DAY", platform: "EBAY" }]);
  const t3 = tag(D.TYPO);
  const o3 = await runImport([ebay("typo.csv", simple(D.TYPO, [`${t3} Erly AM`, "", "43911.5", `${t3} Early  AM`, `${t3} EarlyAM`], 1200))], boss.id);
  const s3 = await byShow(D.TYPO);
  record("3 'Erly AM' / blank / Excel number / double space / 'EarlyAM'", "Erly->AM, double-space->EARLY AM, blank+number+EarlyAM->PM w/ unreadable warning",
    { s3, unreadableWarn: warned(o3, "unreadable Custom Label"), strayWarn: warned(o3, "labelled for the") },
    eq(s3, { "eBay AM": 1, "eBay EARLY AM": 1, "eBay PM": 3 }) && warned(o3, "unreadable Custom Label"));
  const bMsg = o3.flags.find((f) => f.message.includes("not AM, PM or the name"))?.message ?? "";
  record("3b mistyped show name warned?", "warning B names Erly AM", { warnB: bMsg.includes("Erly AM"), msg: bMsg.slice(-90) }, bMsg.includes("Erly AM"));

  // 4 day with no shows
  const t4 = tag(D.NOSHOW);
  const o4 = await runImport([ebay("noshow.csv", simple(D.NOSHOW, [`${t4} Early AM`, `${t4} PM`], 1300))], boss.id);
  const s4 = await byShow(D.NOSHOW);
  record("4 day with no shows scheduled", "accepted as before; Early AM label -> AM + stray warning", { status: o4.status, s4, stray: warned(o4, "labelled for the") }, o4.status === "OK" && eq(s4, { "eBay AM": 1, "eBay PM": 1 }) && warned(o4, "labelled for the"));

  // 5 late payer carried to previous day
  await schedule(D.LATE1, [{ slot: "EARLY AM", platform: "EBAY" }, { slot: "DAY", platform: "EBAY" }]);
  await schedule(D.LATE2, [{ slot: "DAY", platform: "EBAY" }]);
  const ta = tag(D.LATE1), tb = tag(D.LATE2);
  await runImport([ebay("late1.csv", simple(D.LATE1, [`${ta} Early AM`, `${ta} AM`], 1400))], boss.id);
  const o5 = await runImport([ebay("late2.csv", [
    ...simple(D.LATE2, [`${tb} AM`, `${tb} AM`, `${tb} AM`], 1500),
    { srn: "1450", showDay: D.LATE1, paidDay: D.LATE2, label: `${ta} Early AM` },
  ])], boss.id);
  const s5a = await byShow(D.LATE1), s5b = await byShow(D.LATE2);
  record("5 late payer (sold day1 Early AM, paid day2) carried back", "day1: EARLY AM 2, AM 1; day2: AM 3; no stray warning",
    { status: o5.status, s5a, s5b, stray: warned(o5, "labelled for the") },
    eq(s5a, { "eBay AM": 1, "eBay EARLY AM": 2 }) && eq(s5b, { "eBay AM": 3 }) && !warned(o5, "labelled for the"));

  // 5b late checkout: sale date the next day, label day1 Early AM, in day1's report
  await prisma.importBatch.deleteMany({ where: { showDate: { in: [toDbDate(D.CHK)] } } });
  await schedule(D.CHK, [{ slot: "EARLY AM", platform: "EBAY" }, { slot: "DAY", platform: "EBAY" }]);
  const tc = tag(D.CHK);
  const nextDay = "2020-03-20";
  const o5b = await runImport([ebay("chk.csv", [
    ...simple(D.CHK, [`${tc} AM`, `${tc} AM`, `${tc} Early AM`], 1600),
    { srn: "1650", showDay: D.CHK, saleDay: nextDay, paidDay: nextDay, label: `${tc} Early AM` },
  ])], boss.id);
  const s5b2 = await byShow(D.CHK);
  record("5b checked out after midnight (Sale Date next day), label 'day Early AM'", "both Early AM items on EARLY AM (2), AM 2",
    { status: o5b.status, s5b2, stray: warned(o5b, "labelled for the") }, eq(s5b2, { "eBay AM": 2, "eBay EARLY AM": 2 }));

  // 6 cancelled extra eBay show
  await schedule(D.CANC, [{ slot: "EARLY AM", platform: "EBAY", cancelled: true }, { slot: "DAY", platform: "EBAY" }]);
  const t6 = tag(D.CANC);
  const o6 = await runImport([ebay("canc.csv", simple(D.CANC, [`${t6} Early AM`, `${t6} AM`], 1700))], boss.id);
  const s6 = await byShow(D.CANC);
  record("6 extra eBay show cancelled", "Early AM label -> AM, warned", { s6, stray: warned(o6, "labelled for the") }, eq(s6, { "eBay AM": 2 }) && warned(o6, "labelled for the"));

  // 7 extra show only on TikTok that day
  await schedule(D.TTONLY, [{ slot: "EARLY AM", platform: "TIKTOK" }, { slot: "DAY", platform: "EBAY" }]);
  const t7 = tag(D.TTONLY);
  const o7 = await runImport([ebay("tt.csv", simple(D.TTONLY, [`${t7} Early AM`, `${t7} AM`], 1800))], boss.id);
  const s7 = await byShow(D.TTONLY);
  record("7 Early AM exists on TikTok only", "label -> AM, warned", { s7, stray: warned(o7, "labelled for the") }, eq(s7, { "eBay AM": 2 }) && warned(o7, "labelled for the"));

  // 8 diamond eBay (unregistered seller, schedule places it), watch eBay Early AM same day too
  await schedule(D.DIA, [{ slot: "EARLY AM", platform: "EBAY" }, { slot: "DAY", platform: "EBAY" }], "DIAMOND");
  const t8 = tag(D.DIA);
  const o8 = await runImport([ebay("dia.csv", simple(D.DIA, [`${t8} Early AM`, `${t8} AM`, `${t8} PM`], 1900), "diamondtestacct")], boss.id);
  const s8 = await byShow(D.DIA, "DIAMOND");
  const pay8 = await getPayrollPeriod(D.DIA, D.DIA);
  const e8 = pay8.shows.find((s) => s.key.business === "DIAMOND" && s.key.slot === "EARLY AM" && s.key.platform === "EBAY");
  record("8 diamond eBay with Early AM", "DIAMOND batch: EARLY AM 1 AM 1 PM 1; diamond Early AM pair paid", { status: o8.status, s8, paid: e8?.netRevenueCents }, eq(s8, { "eBay AM": 1, "eBay EARLY AM": 1, "eBay PM": 1 }) && e8?.netRevenueCents === 2500);

  // 8b watch account file on a day only diamonds have eBay Early AM
  const o8b = await runImport([ebay("dia-watchacct.csv", simple(D.DIA, [`${t8} Early AM`], 1950))], boss.id);
  const s8b = await byShow(D.DIA, "WATCH");
  record("8b watch-account file, Early AM only on diamond schedule", "watch eBay AM + warnings (not credited to diamond show)", { status: o8b.status, s8b, stray: warned(o8b, "labelled for the") }, eq(s8b, { "eBay AM": 1 }));

  // 9 hijack: an eBay extra show named "TT AM"
  await schedule(D.HIJ, [{ slot: "TT AM", platform: "EBAY" }, { slot: "DAY", platform: "EBAY" }]);
  const t9 = tag(D.HIJ);
  const o9 = await runImport([ebay("hij.csv", simple(D.HIJ, [`${t9} TT AM`, `${t9} AM`], 2000))], boss.id);
  const s9 = await byShow(D.HIJ);
  record("9 an eBay show named 'TT AM' (allowed name)", "TT AM labels go to the TT AM show that day (by design)", { s9 }, eq(s9, { "eBay AM": 1, "eBay TT AM": 1 }));

  // 11 stale label: listed for day1 Early AM, unsold, bought on day2 (day2 has no Early AM)
  await schedule(D.STALE1, [{ slot: "EARLY AM", platform: "EBAY" }, { slot: "DAY", platform: "EBAY" }]);
  await schedule(D.STALE2, [{ slot: "DAY", platform: "EBAY" }, { slot: "NIGHT", platform: "EBAY" }]);
  const s1t = tag(D.STALE1), s2t = tag(D.STALE2);
  const o11 = await runImport([ebay("stale.csv", [
    ...simple(D.STALE2, [`${s2t} AM`, `${s2t} PM`, `${s2t} PM`], 2100),
    { srn: "2150", showDay: D.STALE2, paidDay: D.STALE2, label: `${s1t} Early AM` },
  ])], boss.id);
  const s11 = await byShow(D.STALE2);
  const pay11 = await getPayrollPeriod(D.STALE2, D.STALE2);
  record("11 stale label (yesterday's Early AM listing sold today; today no Early AM)", "a paid show (AM, as before); nothing unattributed",
    { status: o11.status, s11, unattributed: pay11.unattributed.map((u) => u.label) }, pay11.unattributed.length === 0);

  // 12 listed ahead: labelled for tomorrow's Early AM, bought today
  await schedule(D.AHEAD1, [{ slot: "DAY", platform: "EBAY" }, { slot: "NIGHT", platform: "EBAY" }]);
  await schedule(D.AHEAD2, [{ slot: "EARLY AM", platform: "EBAY" }, { slot: "DAY", platform: "EBAY" }]);
  const a1 = tag(D.AHEAD1), a2 = tag(D.AHEAD2);
  const o12 = await runImport([ebay("ahead.csv", [
    ...simple(D.AHEAD1, [`${a1} AM`, `${a1} PM`, `${a1} PM`], 2200),
    { srn: "2250", showDay: D.AHEAD1, paidDay: D.AHEAD1, label: `${a2} Early AM` },
  ])], boss.id);
  const s12 = await byShow(D.AHEAD1);
  const pay12 = await getPayrollPeriod(D.AHEAD1, D.AHEAD1);
  record("12 tomorrow's Early AM listing bought today (today no Early AM)", "nothing unattributed (AM as before)",
    { status: o12.status, s12, unattributed: pay12.unattributed.map((u) => u.label) }, pay12.unattributed.length === 0);

  // 13 ordinary day with odd tokens
  await schedule(D.ORDTOK, [{ slot: "DAY", platform: "EBAY" }, { slot: "NIGHT", platform: "EBAY" }]);
  const ot = tag(D.ORDTOK);
  const o13 = await runImport([ebay("ordtok.csv", simple(D.ORDTOK, [`${ot} TT AM`, `${ot} XYZ PM`, `${ot} AM-PM`, `${ot} NUEVO`, `${ot} AM`], 2300))], boss.id);
  record("13 ordinary day, odd tokens (TT AM, XYZ PM, AM-PM, NUEVO)", "no warning A or B", { A: warned(o13, "labelled for the"), B: warned(o13, "not AM, PM or the name") }, !warned(o13, "labelled for the") && !warned(o13, "not AM, PM or the name"));

  // 14 diamond eBay day with Early AM, ordinary tokens
  await schedule(D.DIATOK, [{ slot: "EARLY AM", platform: "EBAY" }, { slot: "DAY", platform: "EBAY" }], "DIAMOND");
  const dt = tag(D.DIATOK);
  const o14 = await runImport([ebay("diatok.csv", simple(D.DIATOK, [`${dt} TT AM`, `${dt} tt pm`, `${dt} AM-PM`, `${dt} Early AM`, `${dt} PM`], 2400), "diamondtestacct")], boss.id);
  const s14 = await byShow(D.DIATOK, "DIAMOND");
  record("14 diamond day w/ Early AM, ordinary tokens", "no warning B; EARLY AM 1", { status: o14.status, s14, B: warned(o14, "not AM, PM or the name") }, !warned(o14, "not AM, PM or the name") && (s14 as Record<string, number>)["eBay EARLY AM"] === 1);

  // 15 watch day next to a watch eBay Early AM day: a late payer label with a token, on a plain day after
  const o15 = await runImport([ebay("adj.csv", simple(D.STALE2, [`${s2t} XYZ PM`], 2500))], boss.id);
  record("15 plain day adjacent to an Early AM day, label 'XYZ PM' on its own date", "no warning B (its own day has no extra show)", { B: warned(o15, "not AM, PM or the name") }, !warned(o15, "not AM, PM or the name"));

  // 16 keptToday: late payer sold day1 Early AM, paid day2, shares a tracking label with a day2 order; day2 has no Early AM
  await schedule(D.KT1, [{ slot: "EARLY AM", platform: "EBAY" }, { slot: "DAY", platform: "EBAY" }]);
  await schedule(D.KT2, [{ slot: "DAY", platform: "EBAY" }]);
  const k1 = tag(D.KT1), k2 = tag(D.KT2);
  await runImport([ebay("kt1.csv", simple(D.KT1, [`${k1} AM`], 2600))], boss.id);
  const o16 = await runImport([ebay("kt2.csv", [
    { srn: "2700", showDay: D.KT2, paidDay: D.KT2, label: `${k2} AM`, tracking: "9434608106245552999001", buyer: "same_buyer" },
    { srn: "2701", showDay: D.KT2, paidDay: D.KT2, label: `${k2} AM` },
    { srn: "2702", showDay: D.KT2, paidDay: D.KT2, label: `${k2} AM` },
    { srn: "2750", showDay: D.KT1, paidDay: D.KT2, label: `${k1} Early AM`, tracking: "9434608106245552999001", buyer: "same_buyer" },
  ])], boss.id);
  const s16 = await byShow(D.KT2);
  const pay16 = await getPayrollPeriod(D.KT2, D.KT2);
  record("16 keptToday: day1 Early AM late payer kept on day2 (shared label), day2 no Early AM", "nothing unattributed on day2",
    { status: o16.status, s16, unattributed: pay16.unattributed.map((u) => u.label), keptNote: o16.flags.some((f) => f.message.includes("commission counts towards")) }, o16.status === "OK" && pay16.unattributed.length === 0);

  // 10 production-shaped data: every stored eBay label in the dev DB, and which would match a known extra name
  const known = new Set((await prisma.show.findMany({ where: { slot: { notIn: ["DAY", "NIGHT"] } }, distinct: ["slot"], select: { slot: true } })).map((s) => s.slot));
  const labels = await prisma.salesRecord.findMany({ where: { platform: "EBAY", showDate: { notIn: ALL.map(toDbDate) } }, distinct: ["rawShiftTag"], select: { rawShiftTag: true } });
  const words = new Map<string, number>();
  for (const l of labels) { const w = tagShowWords(l.rawShiftTag ?? ""); if (w) words.set(w, (words.get(w) ?? 0) + 1); }
  const hits = [...words.keys()].filter((w) => known.has(w));
  record("10 existing stored eBay labels vs known extra names", "no existing label collides with an extra show name",
    { distinctLabels: labels.length, wordShapes: Object.fromEntries(words), knownNames: [...known], collisions: hits }, hits.length === 0);
} finally {
  await clean();
  console.log(rows.join("\n"));
  await prisma.$disconnect();
}

const failed = rows.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);

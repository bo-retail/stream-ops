/**
 * Seller insights against a real database: the rota, the uploads and the
 * scoring together, in the situations the tab will meet.
 *
 *   - an ordinary fortnight with partners rotating — the best seller comes out on top
 *   - a day's file uploaded twice (corrected) — only the latest counts
 *   - a day whose file never came — its shows are left out, nobody marked down
 *   - the day show's file in but the night's not yet — the night is left out
 *   - a show whose own file is in and sold nothing — a real zero, counted
 *   - an eBay show, whose one file covers the day
 *   - somebody from shipping covering a seat — not scored as a streamer
 *   - a cancelled show — not counted
 *   - a diamond show the same days — on the diamond list only, never the watch one
 *   - somebody who has since left — still listed, marked as left
 *   - a period with no shows — an empty page, not an error
 *
 * Everything is dated 2031 and named after this script. It refuses to run
 * against anything but a local database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-seller-insights.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, toDbDate } from "../src/lib/domain/dates";
import type { Business } from "../src/lib/domain/business";
import { getSellerInsights } from "../src/lib/server/sellers";

assertDevDatabase("check-seller-insights");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const FIXTURE = "check-seller-insights";
const DOMAIN = "@check-seller-insights.test";
const START = "2031-03-01";

async function clearFixtures() {
  await prisma.importBatch.deleteMany({ where: { flags: { path: ["fixture"], equals: FIXTURE } } });
  await prisma.release.deleteMany({ where: { name: { startsWith: FIXTURE } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}
await clearFixtures();

/* --------------------------------------------------------------- fixtures */

const truth: Record<string, number> = { Ava: 0.35, Bo: 0.1, Cy: -0.05, Di: -0.25 };
const people = Object.fromEntries(
  await Promise.all(
    [...Object.keys(truth), "Eve", "Pax"].map(async (name, i) => {
      const u = await prisma.user.create({
        data: {
          name: `${name} ${FIXTURE}`,
          email: `p${i}${DOMAIN}`,
          passwordHash: "x",
          role: "EMPLOYEE",
          // Pax packs, and covers a seat once.
          team: name === "Pax" ? "SHIPPING" : "STREAMING",
        },
        select: { id: true },
      });
      return [name, u.id] as const;
    }),
  ),
) as Record<string, string>;

const pairs: [string, string][] = [
  ["Ava", "Bo"], ["Cy", "Di"], ["Ava", "Cy"], ["Bo", "Di"], ["Ava", "Di"], ["Bo", "Cy"],
];

async function release(business: Business, from: string, to: string) {
  return prisma.release.create({
    data: { name: `${FIXTURE} ${business} ${from}`, business, startDate: toDbDate(from), endDate: toDbDate(to), status: "CLOSED", scheduleStatus: "PUBLISHED" },
    select: { id: true },
  });
}

async function addShow(releaseId: string, business: Business, dateISO: string, slot: "DAY" | "NIGHT", who: string[], status: "SCHEDULED" | "CANCELLED" = "SCHEDULED", platform: "TIKTOK" | "EBAY" = "TIKTOK") {
  const [start, end] = slot === "DAY" ? ["16:00", "20:00"] : ["01:00", "05:00"];
  return prisma.show.create({
    data: {
      releaseId,
      business,
      date: toDbDate(dateISO),
      platform,
      slot,
      status,
      startsAt: new Date(`${dateISO}T${start}:00.000Z`),
      endsAt: new Date(`${dateISO}T${end}:00.000Z`),
      assignments: { create: who.map((n, i) => ({ userId: people[n], seat: i + 1 })) },
    },
  });
}

let line = 0;
/**
 * One checklist line's file, the way the app writes it: TikTok one per show
 * (platform and slot), eBay one per day (slot empty).
 */
async function uploadLine(
  business: Business,
  dateISO: string,
  platform: "TIKTOK" | "EBAY",
  slot: "DAY" | "NIGHT" | null,
  sales: { slot: "DAY" | "NIGHT"; cents: number }[],
  uploadedAt = new Date(),
) {
  return prisma.importBatch.create({
    data: {
      business,
      showDate: toDbDate(dateISO),
      platform,
      slot,
      uploadedAt,
      files: [],
      flags: { fixture: FIXTURE },
      sales: {
        create: sales.map((s) => {
          line += 1;
          return {
            business,
            platform,
            show: `${platform === "EBAY" ? "eBay" : "TikTok"} ${s.slot === "DAY" ? "AM" : "PM"}`,
            showDate: toDbDate(dateISO),
            shiftTag: "A",
            rawShiftTag: "A",
            orderRef: `${FIXTURE}-${line}`,
            lineRef: `${line}`,
            buyer: `buyer${line}`,
            stockNumber: "TEST",
            netItemPriceCents: s.cents,
            sourceFile: FIXTURE,
          };
        }),
      },
    },
  });
}

/** A TikTok day: each show's own file. */
async function upload(business: Business, dateISO: string, sales: { slot: "DAY" | "NIGHT"; cents: number }[], uploadedAt = new Date()) {
  for (const slot of ["DAY", "NIGHT"] as const) {
    const mine = sales.filter((x) => x.slot === slot);
    if (mine.length > 0) await uploadLine(business, dateISO, "TIKTOK", slot, mine, uploadedAt);
  }
}

const watch = await release("WATCH", START, addDays(START, 20));
const diamond = await release("DIAMOND", START, addDays(START, 20));

// Days 0–11: a day show and a night show, partners rotating. Nights sell 5x.
const lift = (a: string, b: string) => (truth[a] + truth[b]) / 2;
for (let d = 0; d < 12; d++) {
  const date = addDays(START, d);
  const [n1, n2] = pairs[d % pairs.length];
  const [d1, d2] = pairs[(d + 3) % pairs.length];
  await addShow(watch.id, "WATCH", date, "NIGHT", [n1, n2]);
  await addShow(watch.id, "WATCH", date, "DAY", [d1, d2]);
  await upload("WATCH", date, [
    { slot: "NIGHT", cents: Math.round(500_000 * (1 + lift(n1, n2))) },
    { slot: "DAY", cents: Math.round(100_000 * (1 + lift(d1, d2))) },
  ]);
}

// Day 12: uploaded, then corrected. The first upload says Di's show made a
// fortune; the correction says it made the normal amount.
const day12 = addDays(START, 12);
await addShow(watch.id, "WATCH", day12, "NIGHT", ["Di", "Cy"]);
await upload("WATCH", day12, [{ slot: "NIGHT", cents: 5_000_000 }], new Date(Date.now() - 3_600_000));
await upload("WATCH", day12, [{ slot: "NIGHT", cents: 420_000 }]);

// Day 13: on the rota, file never came.
const day13 = addDays(START, 13);
await addShow(watch.id, "WATCH", day13, "NIGHT", ["Di", "Bo"]);
await addShow(watch.id, "WATCH", day13, "DAY", ["Di", "Cy"]);

// Day 14: both files in; the day show's file has no sales — it sold nothing.
const day14 = addDays(START, 14);
await addShow(watch.id, "WATCH", day14, "NIGHT", ["Ava", "Bo"]);
await addShow(watch.id, "WATCH", day14, "DAY", ["Cy", "Di"]);
await upload("WATCH", day14, [{ slot: "NIGHT", cents: 560_000 }]);
await uploadLine("WATCH", day14, "TIKTOK", "DAY", []);

// Day 15: a cancelled show; and Pax from shipping covers a seat beside Bo.
const day15 = addDays(START, 15);
await addShow(watch.id, "WATCH", day15, "NIGHT", ["Ava", "Bo"], "CANCELLED");
await addShow(watch.id, "WATCH", day15, "DAY", ["Bo", "Pax"]);
await upload("WATCH", day15, [{ slot: "DAY", cents: 100_000 }]);

// Day 16: the morning after — the day show's file is in, the night's is not.
const day16 = addDays(START, 16);
await addShow(watch.id, "WATCH", day16, "DAY", ["Ava", "Cy"]);
await addShow(watch.id, "WATCH", day16, "NIGHT", ["Bo", "Di"]);
await upload("WATCH", day16, [{ slot: "DAY", cents: 110_000 }]);

// Day 17: an eBay show; its one file for the day has no slot.
const day17 = addDays(START, 17);
await addShow(watch.id, "WATCH", day17, "DAY", ["Ava", "Di"], "SCHEDULED", "EBAY");
await uploadLine("WATCH", day17, "EBAY", null, [{ slot: "DAY", cents: 80_000 }]);

// Diamonds, same days: Eve and Ava.
for (let d = 0; d < 3; d++) {
  const date = addDays(START, d);
  await addShow(diamond.id, "DIAMOND", date, "NIGHT", ["Eve", "Ava"]);
  await upload("DIAMOND", date, [{ slot: "NIGHT", cents: 900_000 }]);
}

// Cy has since left.
await prisma.user.update({ where: { id: people.Cy }, data: { isActive: false } });

/* ------------------------------------------------------------------ checks */

const END = addDays(START, 20);
const w = await getSellerInsights("WATCH", START, END);
const byName = (n: string) => w.sellers.find((s) => s.userId === people[n]);

check("the ordinary fortnight: everybody scored", ["Ava", "Bo", "Cy", "Di"].every((n) => byName(n)));
check(
  "the best seller comes out on top, both readings",
  w.sellers[0]?.userId === people.Ava &&
    [...w.sellers].sort((a, b) => b.effect - a.effect)[0]?.userId === people.Ava,
  w.sellers.map((s) => w.names[s.userId]?.name).join(", "),
);
check(
  "the weakest comes out at the bottom on the partner-adjusted reading",
  [...w.sellers].sort((a, b) => a.effect - b.effect)[0]?.userId === people.Di,
);

const di = byName("Di")!;
check(
  "a file uploaded twice: only the corrected one counts",
  di.revenueCents < 5_000_000,
  `Di's sales came to ${di.revenueCents}`,
);

// Left out: day 13's two shows, and day 16's night show.
check(
  "a file never came, or only the other show's did: those shows are left out",
  w.showsWithoutSales === 3,
  `left out ${w.showsWithoutSales}`,
);

// Scored: 24 (days 0–11) + 1 (12) + 2 (14) + 1 (15) + 1 (16 day) + 1 (17 eBay) = 30.
check(
  "a show whose own file is in and sold nothing counts, a cancelled one does not",
  w.showsScored === 30,
  `scored ${w.showsScored}`,
);
check(
  "an eBay show is joined to its day's eBay file",
  w.baselines.some((b) => b.kind === "EBAY|DAY" && b.shows === 1 && b.perHourCents === 20_000),
  JSON.stringify(w.baselines),
);
check("somebody from shipping covering a seat is not scored", !w.sellers.some((s) => s.userId === people.Pax));

check("a diamond streamer is not on the watch list", !byName("Eve"));
const dm = await getSellerInsights("DIAMOND", START, END);
check(
  "the diamond list has the diamond shows only",
  dm.sellers.length === 2 && dm.sellers.every((s) => s.shows === 3),
  JSON.stringify(dm.sellers.map((s) => [dm.names[s.userId]?.name, s.shows])),
);

check("somebody who left is still listed, marked as left", w.names[people.Cy]?.active === false);

const empty = await getSellerInsights("WATCH", "2031-06-01", "2031-06-30");
check("a period with no shows: an empty result", empty.sellers.length === 0 && empty.showsScored === 0);

await clearFixtures();
console.log(`\n${failures === 0 ? "All passed." : `${failures} failed.`} Fixtures removed.`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);

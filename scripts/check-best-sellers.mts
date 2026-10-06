/**
 * Best-selling watches never lists a random-pull listing as a stock number —
 * against a real database.
 *
 * On 10/06 "Invicta Random Pulls PM Show" sat fourth on the insights page with
 * a fire beside it: a stand-in listing, not a watch anyone can restock. This
 * runs the situations around it:
 *
 *   - the sample-show listing and the "#300 - Invicta Random Pulls" one are left out
 *   - however they are written ("invicta random pull", upper case)
 *   - real stock numbers on the same day are still ranked, and in order
 *   - a stock number that only looks like one ("DC1RAC") is still there
 *   - the revenue of the random pulls still counts in the day's totals
 *   - a day of nothing but random pulls lists no best sellers, not an error
 *   - the random pulls still count in the totals, platform and show splits
 *   - the same day uploaded again: the list and units are not doubled
 *
 * Every file is synthetic and every date years in the past, so nothing here
 * can touch a real day. It refuses to run against anything but a local
 * database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-best-sellers.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { tiktokReport } from "../src/lib/domain/imports/synthetic-exports";
import { runImport } from "../src/lib/server/imports";
import { getSalesInsights } from "../src/lib/server/insights";

assertDevDatabase("check-best-sellers.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`,
  );
  if (!ok) failures++;
}

const DAY = "2021-11-15";
const ONLY_PULLS = "2021-11-16";

async function clean() {
  const batches = await prisma.importBatch.findMany({
    where: { showDate: { in: [DAY, ONLY_PULLS].map(toDbDate) } },
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

await clean();
try {
  const names = [
    ...Array(4).fill("Invicta Random Pulls PM Show"),
    ...Array(3).fill("#300 - Invicta Random Pulls"),
    "invicta random pull",
    "INVICTA RANDOM PULLS AM SHOW",
    ...Array(3).fill("BS10001"),
    ...Array(2).fill("DC1RAC"),
    "BS10002",
  ];
  const day = await runImport(
    [{ name: "tiktok.csv", text: tiktokReport("vaultshowlive", DAY, names.length, "58100001", { names }) }],
    boss.id,
  );
  check("the day with random pulls goes in", day.status, "OK");

  const one = await getSalesInsights(DAY as never, DAY as never);
  const listed = one.bestSellers.map((m) => [m.stockNumber, m.units]);
  check("only real stock numbers are ranked, most sold first", listed, [
    ["BS10001", 3],
    ["DC1RAC", 2],
    ["BS10002", 1],
  ]);
  check(
    "no random-pull listing, however it is written",
    one.bestSellers.filter((m) => /random|pull/i.test(m.stockNumber)).length,
    0,
  );
  check("the random pulls' units still count in the day", one.daily[0]?.watches, names.length);
  const each = one.bestSellers[0].revenueCents / 3;
  check("…and their money in the totals", one.totals.revenueCents, each * names.length);
  check("…and in the platform split", one.byPlatform.reduce((n, p) => n + p.revenueCents, 0), each * names.length);
  check("…and in the show split", one.byShow.reduce((n, p) => n + p.revenueCents, 0), each * names.length);

  // The same report uploaded again, as a correction: read once, nothing doubled.
  const again = await runImport(
    [{ name: "tiktok-again.csv", text: tiktokReport("vaultshowlive", DAY, names.length, "58100001", { names }) }],
    boss.id,
  );
  check("the same day uploaded again goes in", again.status, "OK");
  const twice = await getSalesInsights(DAY as never, DAY as never);
  check("…and the list is the same, nothing doubled", twice.bestSellers.map((m) => [m.stockNumber, m.units]), listed);
  check("…and the day's units are not doubled", twice.daily[0]?.watches, names.length);

  const pulls = ["Invicta Random Pulls PM Show", "#300 - Invicta Random Pulls"];
  const only = await runImport(
    [{ name: "tiktok-pulls.csv", text: tiktokReport("vaultshowlive", ONLY_PULLS, 2, "58100002", { names: pulls }) }],
    boss.id,
  );
  check("a day of nothing but random pulls goes in", only.status, "OK");
  const empty = await getSalesInsights(ONLY_PULLS as never, ONLY_PULLS as never);
  check("…and lists no best sellers, without an error", empty.bestSellers.length, 0);
  check("…while its units still count", empty.daily[0]?.watches, 2);
} finally {
  await clean();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll passed." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Proves a day is a checklist of files rather than one all-or-nothing report.
 *
 * The old model made an upload BE the day: a second one replaced everything the
 * first had written, and open boxes it did not mention were removed. Sending up
 * a single missing file would have taken every other sale and every unpacked box
 * with it, which is why a guard had to exist to stop anybody doing it — and that
 * guard is what refused Flora's diamond file on 09/16.
 *
 * Files now go up one at a time, in any order, and each replaces only its own
 * line. These checks upload them separately and confirm nothing crosses over.
 *
 * Uses the real exports, so it is skipped without them.
 *
 *   STREAMOPS_IMPORT_FIXTURES_0914=<folder with the 09/14 exports> \
 *   DIAMOND_EXPORT=<the 09/15 diamond export> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-upload-checklist.mts
 *
 * Everything it creates is removed at the end, including on the failure paths.
 */
import "dotenv/config";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { runImport } from "../src/lib/server/imports";
import { latestBatchIds } from "../src/lib/server/sales-data";

assertDevDatabase("check-upload-checklist.mts");

const dir = process.env.STREAMOPS_IMPORT_FIXTURES_0914;
const diamondPath = process.env.DIAMOND_EXPORT;
if (!dir || !existsSync(dir) || !diamondPath || !existsSync(diamondPath)) {
  console.log(
    "SKIP  needs STREAMOPS_IMPORT_FIXTURES_0914 (the 09/14 exports) and DIAMOND_EXPORT.",
  );
  await prisma.$disconnect();
  process.exit(0);
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

const names = readdirSync(dir);
const file = (match: (n: string) => boolean) => {
  const name = names.find(match);
  if (!name) throw new Error(`no fixture matching in ${dir}`);
  return { name, text: readFileSync(`${dir}/${name}`, "utf8") };
};

// The two TikTok exports are told apart by their order times, so which is which
// is decided by the parser rather than by the file name.
const tiktokFiles = names.filter((n) => n.startsWith("All order")).sort();
const tiktokA = { name: tiktokFiles[0], text: readFileSync(`${dir}/${tiktokFiles[0]}`, "utf8") };
const tiktokB = { name: tiktokFiles[1], text: readFileSync(`${dir}/${tiktokFiles[1]}`, "utf8") };
const ebay = file((n) => n.startsWith("eBay"));
const diamond = { name: "diamond.csv", text: readFileSync(diamondPath, "utf8") };

const WATCH_DAY = "2026-09-14";
const DIAMOND_DAY = "2026-09-15";

async function clean() {
  for (const day of [WATCH_DAY, DIAMOND_DAY]) {
    const batches = await prisma.importBatch.findMany({
      where: { showDate: toDbDate(day) },
      select: { id: true },
    });
    const ids = batches.map((b) => b.id);
    if (ids.length === 0) continue;
    // Boxes nobody has scanned. A scanned one is evidence and the database
    // refuses to delete it, which is correct — this only clears its own mess.
    await prisma.package.deleteMany({ where: { batchId: { in: ids }, scans: { none: {} } } });
    await prisma.package.updateMany({ where: { batchId: { in: ids } }, data: { batchId: null } });
    await prisma.importBatch.deleteMany({ where: { id: { in: ids } } });
  }
}

const boss = await prisma.user.findFirstOrThrow({
  where: { role: "BOSS", isActive: true },
  select: { id: true },
});

await clean();

try {
  /* ------------------------------ one file at a time, in the wrong order */

  // Deliberately not the order they are produced in. Any order must work.
  const first = await runImport([ebay], boss.id);
  check("an eBay file on its own is accepted", first.status, "OK");

  const afterEbay = await prisma.salesRecord.count({ where: { showDate: toDbDate(WATCH_DAY) } });
  check("and its sales are in", afterEbay > 0, true);

  const second = await runImport([tiktokA], boss.id);
  check("a TikTok file added afterwards is accepted", second.status, "OK");

  /*
    The failure the old model had.

    A second upload used to replace the day, so adding the TikTok file would
    have wiped every eBay sale and every unpacked eBay box that went in first.
  */
  const ebayStillThere = await prisma.salesRecord.count({
    where: { showDate: toDbDate(WATCH_DAY), platform: "EBAY" },
  });
  check("and the eBay sales are still there", ebayStillThere, afterEbay);

  const third = await runImport([tiktokB], boss.id);
  check("and the second TikTok file too", third.status, "OK");

  const lines = await prisma.importBatch.findMany({
    where: { showDate: toDbDate(WATCH_DAY), status: "OK" },
    select: { platform: true, slot: true },
  });
  check("three separate lines were written, not three whole days", lines.length, 3);
  check(
    "one for each file: eBay, TikTok day, TikTok night",
    lines
      .map((l) => `${l.platform}${l.slot ? `-${l.slot}` : ""}`)
      .sort()
      .join(","),
    "EBAY,TIKTOK-DAY,TIKTOK-NIGHT",
  );

  /*
    Counted through `latestBatchIds`, the way payroll and insights read it.

    A raw count of the table would include superseded uploads, which are kept on
    record on purpose so "what did the first one say" stays answerable. What
    matters is what the day currently reads.
  */
  const liveSales = async (day: string) =>
    prisma.salesRecord.count({ where: { batchId: { in: await latestBatchIds(day, day) } } });

  check("every sale from all three files is loaded", await liveSales(WATCH_DAY), 591);

  /* -------------------------------- re-uploading one replaces only itself */

  const boxesBefore = await prisma.package.count({ where: { showDate: toDbDate(WATCH_DAY) } });
  const again = await runImport([tiktokA], boss.id);
  check("the same file can be sent again", again.status, "OK");
  check("the day still has every sale, none doubled", await liveSales(WATCH_DAY), 591);
  check(
    "and every box, none swept away",
    await prisma.package.count({ where: { showDate: toDbDate(WATCH_DAY) } }),
    boxesBefore,
  );
  check(
    "still three lines, the old one superseded rather than added to",
    await prisma.importBatch.count({ where: { showDate: toDbDate(WATCH_DAY), status: "OK" } }),
    4, // three lines, and the re-upload of one of them
  );

  /* ----------------------------- and a diamond report is its own day entirely */

  const dia = await runImport([diamond], boss.id);
  check("the diamond export is accepted", dia.status, "OK");
  check(
    "it lands on its own kind of show",
    (
      await prisma.importBatch.findFirstOrThrow({
        where: { showDate: toDbDate(DIAMOND_DAY), status: "OK" },
        select: { business: true },
      })
    ).business,
    "DIAMOND",
  );
  check("and every watch sale is untouched by it", await liveSales(WATCH_DAY), 591);
} finally {
  console.log("\nCleaning up.");
  await clean();
  const left = await prisma.importBatch.count({
    where: { showDate: { in: [toDbDate(WATCH_DAY), toDbDate(DIAMOND_DAY)] } },
  });
  console.log(`Removed — ${left} upload(s) left.`);
  if (left > 0) failures++;
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll upload-checklist checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

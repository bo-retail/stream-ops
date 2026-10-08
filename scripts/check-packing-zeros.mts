/**
 * A watch tag with a model's leading zeros, against a report without them —
 * against a real database.
 *
 * Invicta writes some models with leading zeros (0069, 0071, 0072) and the
 * reports list them without ("71"). Samuel, 10/08: they are the same watch. So
 * the packing screen takes either spelling into the box:
 *
 *   - a tag of 000973117 into a box listed 973117: accepted, and the box closes
 *   - a tag of 973119 into a box listed 0000973119: accepted
 *   - the exact spelling still works as before
 *   - a box listing two lines that differ only by zeros: neither guessed
 *   - a different number (9731210) or a number with letters: still refused
 *   - the box then counts as sent for stock, with no "different watch" note
 *   - a diamond box: its piece numbers are taken exactly as scanned
 *
 * Every file is synthetic and the date years in the past. It refuses to run
 * against anything but a local database, and removes what it made.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-packing-zeros.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { wantedSales } from "../src/lib/domain/deduction";
import { catalogueSpelling } from "../src/lib/domain/inventory";
import { tiktokReport } from "../src/lib/domain/imports/synthetic-exports";
import { runImport } from "../src/lib/server/imports";
import { getBoxById, packItem } from "../src/lib/server/packing";
import type { ScanOutcome } from "../src/lib/server/packing";

assertDevDatabase("check-packing-zeros.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const DAY = "2021-12-07";
const showDate = toDbDate(DAY);

async function clean() {
  const boxes = (await prisma.package.findMany({ where: { showDate }, select: { id: true } })).map((b) => b.id);
  await prisma.scanEvent.deleteMany({ where: { packageId: { in: boxes } } });
  await prisma.packageItem.deleteMany({ where: { packageId: { in: boxes } } });
  await prisma.package.deleteMany({ where: { id: { in: boxes } } });
  await prisma.importBatch.deleteMany({ where: { showDate } });
}

const boss = await prisma.user.findFirstOrThrow({ where: { role: "BOSS", isActive: true }, select: { id: true } });
const kind = (o: ScanOutcome) => o.kind;
const box = async (tracking: string) => {
  const p = await prisma.package.findFirstOrThrow({ where: { showDate, trackingNumber: tracking }, select: { id: true } });
  return (await getBoxById(p.id))!;
};
const lines = async (tracking: string) => (await box(tracking)).items.map((i) => [i.stockNumber, i.scanned]);

await clean();
try {
  const names = ["973117", "0000973119", "973120", "0973120", "973121"];
  const tracking = ["ZZ0TA", "ZZ0TB", "ZZ0TC", "ZZ0TC", "ZZ0TD"];
  const up = await runImport(
    [{ name: "tiktok.csv", text: tiktokReport("vaultshowlive", DAY, names.length, "58200001", { names, tracking, buyer: "zerobuyer" }) }],
    boss.id,
  );
  check("the report goes in", up.status, "OK");

  const a = await box("ZZ0TA");
  const r1 = await packItem(boss.id, a.id, "000973117");
  check("a tag of 000973117 goes into the box listed 973117", [kind(r1), await lines("ZZ0TA")], ["box", [["973117", 1]]]);
  check("…and the box closes itself, complete", (await box("ZZ0TA")).status, "CLOSED_COMPLETE");
  const ev = await prisma.scanEvent.findFirst({ where: { packageId: a.id, kind: "ITEM_ACCEPTED" }, select: { stockNumber: true, rawScan: true } });
  check("…recorded as the box's line, with the tag as scanned", [ev?.stockNumber, ev?.rawScan], ["973117", "000973117"]);

  const b = await box("ZZ0TB");
  const r2 = await packItem(boss.id, b.id, "973119");
  check("a tag of 973119 goes into the box listed 0000973119", [kind(r2), await lines("ZZ0TB")], ["box", [["0000973119", 1]]]);

  const c = await box("ZZ0TC");
  const r3 = await packItem(boss.id, c.id, "00973120");
  check("a box listing 973120 and 0973120: 00973120 is not guessed", kind(r3), "refused");
  const r4 = await packItem(boss.id, c.id, "0973120");
  check("…the exact spelling still goes in", [kind(r4), (await lines("ZZ0TC")).sort()], ["box", [["0973120", 1], ["973120", 0]]]);
  const r5 = await packItem(boss.id, c.id, "973120");
  check("…and so does the other", [kind(r5), (await lines("ZZ0TC")).sort()], ["box", [["0973120", 1], ["973120", 1]]]);

  const d = await box("ZZ0TD");
  check("a different number is still refused", kind(await packItem(boss.id, d.id, "9731210")), "refused");
  check("a number with letters is still refused", kind(await packItem(boss.id, d.id, "A973121")), "refused");
  check("nothing went in", await lines("ZZ0TD"), [["973121", 0]]);

  const dia = await runImport(
    [{ name: "diamond.csv", text: tiktokReport("caratclublive", DAY, 1, "58200002", { names: ["973123"], tracking: "ZZ0TE", buyer: "zerodiamond" }) }],
    boss.id,
  );
  check("a diamond report goes in", dia.status, "OK");
  const e = await box("ZZ0TE");
  check("a diamond box listing 973123 refuses a scan of 0973123", [e.business, kind(await packItem(boss.id, e.id, "0973123"))], ["DIAMOND", "refused"]);
  check("…and takes 973123", kind(await packItem(boss.id, e.id, "973123")), "box");

  // Stock reads the box the way deduction does: by the box's own line.
  const a2 = await prisma.package.findUniqueOrThrow({
    where: { id: a.id },
    select: { status: true, items: { select: { stockNumber: true, scannedQty: true } } },
  });
  const w = wantedSales(
    [{ platform: "TIKTOK", orderRef: "o", lineRef: "1", showDate: DAY, show: "TikTok AM", tracking: "ZZ0TA", stockNumber: "973117", modelNumber: "", qty: 1, batchId: "b", uploadedAt: 1 }],
    new Map([["ZZ0TA", { status: a2.status, scanned: Object.fromEntries(a2.items.map((i) => [i.stockNumber, i.scannedQty])), pieces: {} }]]),
    () => false,
    catalogueSpelling(["000973117"]),
  ).wanted[0];
  check("for stock: the watch is 000973117, sent, with no note", [w.model, w.sent, w.note], ["000973117", true, ""]);
} finally {
  await clean();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll passed." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * What the scanner does with the scan that comes straight after a box is closed.
 *
 * On the floor the rhythm is: label, watches, close, next label. The screen
 * used to keep hold of the box it had just closed, so that next label was sent
 * as a watch, answered "already packed" — about a box that had nothing to do
 * with it — and thrown away. Every parcel cost a wasted scan, and the packers
 * reported it as the app telling them things were already packed at random.
 *
 * So: a label scanned against a closed box opens that label's box, and a watch
 * scanned against a closed box is still refused, because nothing can go into a
 * box that has gone.
 *
 * This is the server half only. The screen's half — letting go of a box once it
 * is closed, and queueing scans rather than dropping them — has no test here:
 * there is nothing in this project that can drive a React component.
 *
 * Its own boxes, so it needs no export files and no schedule:
 *
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-scan-after-close.mts
 *
 * Everything it creates is removed at the end, including on the paths that fail.
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { openBoxByScan, packItem, sealBox } from "../src/lib/server/packing";
import { packingDayISO } from "../src/lib/server/settings";

assertDevDatabase("check-scan-after-close.mts");

/** Long enough to read as a shipping label, and no real parcel's number. */
const LABEL_A = "9999000011112222333344";
const LABEL_B = "9999000011112222333355";
const BUYER = "check-scan-after-close";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

async function cleanUp() {
  const boxes = await prisma.package.findMany({
    where: { trackingNumber: { in: [LABEL_A, LABEL_B] } },
    select: { id: true },
  });
  const ids = boxes.map((b) => b.id);
  if (ids.length === 0) return;
  await prisma.scanEvent.deleteMany({ where: { packageId: { in: ids } } });
  await prisma.packageItem.deleteMany({ where: { packageId: { in: ids } } });
  await prisma.package.deleteMany({ where: { id: { in: ids } } });
}

// Outside the try: `process.exit` does not run a `finally`, so skipping from
// inside it would leave the connection open.
const packer = await prisma.user.findFirst({ where: { isActive: true }, select: { id: true } });
if (!packer) {
  console.log("SKIP  need an account. Run the seed first.");
  await prisma.$disconnect();
  process.exit(0);
}

try {
  await cleanUp();

  const showDate = toDbDate(await packingDayISO());
  const boxA = await prisma.package.create({
    data: {
      trackingNumber: LABEL_A,
      platform: "TIKTOK",
      showDate,
      buyer: BUYER,
      items: { create: [{ stockNumber: "70001", expectedQty: 1, scannedQty: 0 }] },
    },
    select: { id: true },
  });
  await prisma.package.create({
    data: {
      trackingNumber: LABEL_B,
      platform: "TIKTOK",
      showDate,
      buyer: BUYER,
      items: { create: [{ stockNumber: "70002", expectedQty: 1, scannedQty: 0 }] },
    },
  });

  /* The ordinary run: label, watch, close. */
  const opened = await openBoxByScan(packer.id, LABEL_A);
  check("the label opens its box", opened.kind, "box");

  const packed = await packItem(packer.id, boxA.id, "70001");
  check("the watch goes in", packed.kind === "box" && packed.box.complete, true);

  const closed = await sealBox(packer.id, boxA.id, false);
  check("the box closes", closed.kind === "box" && closed.box.status, "CLOSED_COMPLETE");

  /* The scan this check exists for. */
  const next = await packItem(packer.id, boxA.id, LABEL_B);
  check("the next label opens the next box, not refused", next.kind, "box");
  check(
    "and it is that label's box",
    next.kind === "box" ? next.box.tracking : null,
    LABEL_B,
  );

  /* The closed box's own label is honestly already packed. */
  const again = await packItem(packer.id, boxA.id, LABEL_A);
  check(
    "its own label reads as already packed, and as that box",
    again.kind === "alreadyPacked" ? again.box.tracking : again.kind,
    LABEL_A,
  );

  /* A watch, though, still cannot go into a box that has gone. */
  const late = await packItem(packer.id, boxA.id, "70001");
  check("a watch into a closed box is still refused", late.kind, "alreadyPacked");

  /* Nothing was written to the closed box by any of that. */
  const after = await prisma.packageItem.findFirst({
    where: { packageId: boxA.id, stockNumber: "70001" },
    select: { scannedQty: true },
  });
  check("the closed box still holds exactly what it held", after?.scannedQty, 1);

  const stray = await prisma.scanEvent.count({
    where: { packageId: boxA.id, kind: { in: ["ITEM_ACCEPTED", "ITEM_REFUSED"] }, rawScan: LABEL_B },
  });
  check("the next parcel's label was not logged as a watch", stray, 0);
} finally {
  console.log("\nCleaning up.");
  await cleanUp();
  const left = await prisma.package.count({ where: { trackingNumber: { in: [LABEL_A, LABEL_B] } } });
  console.log(`Removed — ${left} fixture box(es) left.`);
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll scan-after-close checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

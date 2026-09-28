/**
 * An order that shipped in two parcels, scanned from either label.
 *
 * eBay writes both labels into one cell — `(9434…438,9434…593)` — and the box
 * is stored under that cell. On 09/26 that was 90 of the day's 158 parcels, and
 * neither label would open its box: the packer scanned a real label and was
 * told it was in no report at all.
 *
 * So both of them are walked here, from the scan a real scanner produces —
 * routing prefix and all — through to the box opening.
 *
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-two-parcel-labels.mts
 *
 * Everything it creates is removed at the end, including on the paths that fail.
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { createUnknownBox, openBoxByScan, packItem } from "../src/lib/server/packing";
import { packingDayISO } from "../src/lib/server/settings";

assertDevDatabase("check-two-parcel-labels.mts");

/** Both labels of one order, as eBay writes them, and no real parcel's numbers. */
const FIRST = "9434608106244595870001";
const SECOND = "9434608106245614270002";
const CELL = `(${FIRST},${SECOND})`;
const ALONE = "9434608106245614270003";
const BUYER = "check-two-parcel-labels";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

async function cleanUp() {
  const boxes = await prisma.package.findMany({ where: { buyer: BUYER }, select: { id: true } });
  const ids = boxes.map((b) => b.id);
  if (ids.length === 0) return;
  await prisma.scanEvent.deleteMany({ where: { packageId: { in: ids } } });
  await prisma.packageItem.deleteMany({ where: { packageId: { in: ids } } });
  await prisma.package.deleteMany({ where: { id: { in: ids } } });
}

const packer = await prisma.user.findFirst({ where: { isActive: true }, select: { id: true } });
if (!packer) {
  console.log("SKIP  need an account. Run the seed first.");
  await prisma.$disconnect();
  process.exit(0);
}

try {
  await cleanUp();
  const showDate = toDbDate(await packingDayISO());

  const twoParcels = await prisma.package.create({
    data: {
      trackingNumber: CELL,
      platform: "EBAY",
      showDate,
      buyer: BUYER,
      items: { create: [{ stockNumber: "70101", expectedQty: 2, scannedQty: 0 }] },
    },
    select: { id: true },
  });
  await prisma.package.create({
    data: {
      trackingNumber: ALONE,
      platform: "EBAY",
      showDate,
      buyer: BUYER,
      items: { create: [{ stockNumber: "70102", expectedQty: 1, scannedQty: 0 }] },
    },
  });

  /*
    The scanner returns the routing prefix wrapped around the tracking number.
    A real IMpb barcode is 30 or 34 digits, so both are walked: a ceiling on how
    long a label may be truncates the longer one, and a number that is not its
    own label cannot find its own box.
  */
  const scanned = (label: string) => `42063048${label}`; // 30 digits
  const scannedLong = (label: string) => `420630481234${label}`; // 34 digits

  const first = await openBoxByScan(packer.id, scanned(FIRST));
  check("the first label opens the order's box", first.kind, "box");
  check(
    "and it is that order",
    first.kind === "box" ? first.box.id : null,
    twoParcels.id,
  );

  const second = await openBoxByScan(packer.id, scanned(SECOND));
  check("the second label opens the same box", second.kind === "box" ? second.box.id : null, twoParcels.id);

  check(
    "the packer is shown a label, not the raw cell",
    second.kind === "box" ? second.box.tracking : null,
    `${FIRST} +1 more`,
  );

  /* A watch still goes in, and the box is still one box. */
  const packed = await packItem(packer.id, twoParcels.id, "70101");
  check("a watch goes into it", packed.kind === "box" ? packed.box.totalScanned : null, 1);

  /* An ordinary single-label parcel is untouched by any of this. */
  const plain = await openBoxByScan(packer.id, scanned(ALONE));
  check("an ordinary label still opens its own box", plain.kind, "box");
  check(
    "and shows its number as it is",
    plain.kind === "box" ? plain.box.tracking : null,
    ALONE,
  );

  const longScan = await openBoxByScan(packer.id, scannedLong(SECOND));
  check("a 34-digit scan finds it too", longScan.kind === "box" ? longScan.box.id : null, twoParcels.id);

  /* The label of one order must never open another's. */
  const stranger = await openBoxByScan(packer.id, scanned("9434608106244595879999"));
  check("a label belonging to nothing opens nothing", stranger.kind, "unknownLabel");

  /*
    A box stored under a value long enough that a ceiling would clip it. It has
    to find itself, and starting an unknown box for it must not collide with
    the row already there.
  */
  const LONG = "420630481234" + ALONE; // 34 digits, kept verbatim as a box
  await prisma.package.create({
    data: { trackingNumber: LONG, platform: "TIKTOK", showDate, buyer: BUYER, isUnrecognised: true },
  });
  const itself = await openBoxByScan(packer.id, LONG);
  check("a long stored label still finds its own box", itself.kind, "box");
  const again = await createUnknownBox(packer.id, LONG);
  check("and starting it again returns the box rather than throwing", again.kind, "box");

  /*
    The same label on two boxes: the second parcel of a two-parcel order listed
    alone in an earlier report. The scan cannot say which is meant.
  */
  await prisma.package.create({
    data: { trackingNumber: SECOND, platform: "EBAY", showDate, buyer: BUYER },
  });
  const twoWays = await openBoxByScan(packer.id, scanned(SECOND));
  check("a label on two boxes is refused, not treated as unknown", twoWays.kind, "error");
  check(
    "and the refusal says to ask rather than offering a new box",
    twoWays.kind === "error" ? twoWays.message.includes("ask the director") : false,
    true,
  );
} finally {
  console.log("\nCleaning up.");
  await cleanUp();
  const left = await prisma.package.count({ where: { buyer: BUYER } });
  console.log(`Removed — ${left} fixture box(es) left.`);
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll two-parcel label checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * A box closes itself on the scan that completes it — against a real database.
 *
 * The shipping manager asked on 10/01 for the packer not to have to press
 * Close after the last watch. This runs the situations that change meets at
 * the table:
 *
 *   - one watch, several watches, the same watch three times
 *   - a box still short: stays open, and closing it incomplete still works
 *   - something added against the report: never closes itself
 *   - a box in no report: never closes itself
 *   - a placeholder piece completing a diamond box
 *   - Undo straight away, by the packer it closed on — and not by anybody
 *     else, not twice, not too late
 *   - the last watch scanned twice (the scanner double-reading)
 *   - two scanners scanning the last two watches of one box at once
 *   - Undo after the director has marked the day sent
 *
 * Every box is made up and labelled with a number no real parcel has. It
 * refuses to run against anything but a local database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-auto-close.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import {
  AUTO_CLOSE_NOTE,
  createUnknownBox,
  openBoxByScan,
  markDaySent,
  overrideItem,
  packItem,
  sealBox,
  undoAutoClose,
} from "../src/lib/server/packing";
import type { ScanOutcome } from "../src/lib/server/packing";
import { packingDayISO } from "../src/lib/server/settings";

assertDevDatabase("check-auto-close.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`,
  );
  if (!ok) failures++;
}

/** Long enough to read as a shipping label, and no real parcel's number. */
const label = (n: number) => `99990000777788880000${String(n).padStart(2, "0")}`;
const LABELS = Array.from({ length: 12 }, (_, i) => label(i + 1));
const BUYER = "check-auto-close";

const status = (o: ScanOutcome) => (o.kind === "box" || o.kind === "refused" || o.kind === "alreadyPacked" ? o.box.status : o.kind);
const autoClosed = (o: ScanOutcome) => o.kind === "box" && o.autoClosed === true;

async function cleanUp() {
  const boxes = await prisma.package.findMany({
    where: { trackingNumber: { in: LABELS } },
    select: { id: true },
  });
  const ids = boxes.map((b) => b.id);
  if (ids.length === 0) return;
  await prisma.scanEvent.deleteMany({ where: { packageId: { in: ids } } });
  await prisma.packageItem.deleteMany({ where: { packageId: { in: ids } } });
  await prisma.package.deleteMany({ where: { id: { in: ids } } });
}

const people = await prisma.user.findMany({ where: { isActive: true }, select: { id: true }, take: 2 });
if (people.length < 2) {
  console.log("SKIP  needs two accounts. Run the seed first.");
  await prisma.$disconnect();
  process.exit(0);
}
const [packer, other] = people;

let showDate: Date;
async function box(n: number, items: [string, number][]) {
  const created = await prisma.package.create({
    data: {
      trackingNumber: label(n),
      platform: "TIKTOK",
      showDate,
      buyer: BUYER,
      items: { create: items.map(([stockNumber, expectedQty]) => ({ stockNumber, expectedQty, scannedQty: 0 })) },
    },
    select: { id: true },
  });
  await openBoxByScan(packer.id, label(n));
  return created.id;
}

try {
  await cleanUp();
  showDate = toDbDate(await packingDayISO());

  /* ---------------------------------------------------------- one watch */

  console.log("One watch.");
  const one = await box(1, [["80001", 1]]);
  const r1 = await packItem(packer.id, one, "80001");
  check("the only watch closes the box", status(r1), "CLOSED_COMPLETE");
  check("and the screen is told it closed itself", autoClosed(r1), true);
  const closeEvents = await prisma.scanEvent.findMany({
    where: { packageId: one, kind: "CLOSE_COMPLETE" },
    select: { note: true, userId: true },
  });
  check("the log has one close, by the packer, saying so", closeEvents, [{ note: AUTO_CLOSE_NOTE, userId: packer.id }]);
  check(
    "it is closed by her, as if she had pressed Close",
    (await prisma.package.findUniqueOrThrow({ where: { id: one }, select: { closedById: true } })).closedById,
    packer.id,
  );

  /* --------------------------------------- the last watch scanned twice */

  const dup = await packItem(packer.id, one, "80001");
  check("the scanner reading it again is told the box is packed", dup.kind, "alreadyPacked");
  check(
    "and nothing more goes in",
    (await prisma.packageItem.findFirstOrThrow({ where: { packageId: one }, select: { scannedQty: true } })).scannedQty,
    1,
  );
  await prisma.package.create({
    data: {
      trackingNumber: label(2),
      platform: "TIKTOK",
      showDate,
      buyer: BUYER,
      items: { create: [{ stockNumber: "80011", expectedQty: 1, scannedQty: 0 }] },
    },
  });
  const next = await packItem(packer.id, one, label(2));
  check("the next label still opens the next box", next.kind === "box" ? next.box.tracking : next.kind, label(2));

  /* --------------------------------------------- several, and repeats */

  console.log("\nSeveral watches.");
  const many = await box(3, [["80002", 3], ["80003", 1]]);
  const steps = [];
  for (const scan of ["80002", "80003", "80002", "80002"]) steps.push(status(await packItem(packer.id, many, scan)));
  check("it stays open until the last one, then closes", steps, ["OPEN", "OPEN", "OPEN", "CLOSED_COMPLETE"]);

  /* ---------------------------------------------------------- short */

  console.log("\nShort.");
  const short = await box(4, [["80004", 2]]);
  check("one of two leaves it open", status(await packItem(packer.id, short, "80004")), "OPEN");
  const forced = await sealBox(packer.id, short, true, "second one damaged");
  check("closing it incomplete still works", status(forced), "CLOSED_INCOMPLETE");

  /* ---------------------------------------------- something added on top */

  console.log("\nSomething added against the report.");
  const over = await box(5, [["80005", 1]]);
  await overrideItem(packer.id, over, "EXTRA-1");
  const afterOver = await packItem(packer.id, over, "80005");
  check("a box with an extra never closes itself", status(afterOver), "OPEN");
  check("and Close incomplete is what records it", status(await sealBox(packer.id, over, true)), "CLOSED_INCOMPLETE");

  /* ------------------------------------------------------- no report */

  console.log("\nA box in no report.");
  const unknown = await createUnknownBox(packer.id, label(6));
  const unknownId = unknown.kind === "box" ? unknown.box.id : "";
  check("it is opened", unknown.kind, "box");
  check("and stays open whatever is scanned", status(await packItem(packer.id, unknownId, "80006")), "OPEN");

  /* ---------------------------------------------------- a placeholder */

  console.log("\nA diamond box sold under a placeholder.");
  const ph = await box(7, [["LGD #1", 1]]);
  const phr = await packItem(packer.id, ph, "E98761");
  check("the piece's tag fills the placeholder and closes the box", status(phr), "CLOSED_COMPLETE");
  check(
    "and says both",
    phr.kind === "box" && phr.autoClosed === true && /E98761 recorded.*Complete — closed\./.test(phr.message ?? ""),
    true,
  );

  /* -------------------------------------------------------------- undo */

  console.log("\nUndo.");
  const u = await box(8, [["80008", 1]]);
  await packItem(packer.id, u, "80008");
  check("somebody else cannot undo it", (await undoAutoClose(other.id, u)).kind, "error");
  const undone = await undoAutoClose(packer.id, u);
  check("the packer it closed on can, straight away", status(undone), "OPEN");
  check(
    "the reopen is in the log",
    (await prisma.scanEvent.count({ where: { packageId: u, kind: "REOPEN" } })),
    1,
  );
  check("and she can put more in", (await packItem(packer.id, u, "EXTRA-2")).kind, "refused");
  check("undo twice does nothing", (await undoAutoClose(packer.id, u)).kind, "error");
  check("a box she closed by hand is not undone this way", (await undoAutoClose(packer.id, short)).kind, "error");

  const late = await box(9, [["80009", 1]]);
  await packItem(packer.id, late, "80009");
  await prisma.scanEvent.updateMany({
    where: { packageId: late, kind: "CLOSE_COMPLETE" },
    data: { at: new Date(Date.now() - 60_000) },
  });
  check("a minute later it is the director's to reopen", (await undoAutoClose(packer.id, late)).kind, "error");
  check(
    "and it is still closed",
    (await prisma.package.findUniqueOrThrow({ where: { id: late }, select: { status: true } })).status,
    "CLOSED_COMPLETE",
  );

  /* ------------------------------- two scanners, the last two watches */

  console.log("\nTwo scanners finishing the same box.");
  const race = await box(10, [["80010", 2]]);
  const both = await Promise.all([packItem(packer.id, race, "80010"), packItem(other.id, race, "80010")]);
  check("it ends closed", (await prisma.package.findUniqueOrThrow({ where: { id: race }, select: { status: true } })).status, "CLOSED_COMPLETE");
  check(
    "closed once, not twice",
    await prisma.scanEvent.count({ where: { packageId: race, kind: "CLOSE_COMPLETE" } }),
    1,
  );
  check("and exactly one scanner was told it closed itself", both.filter(autoClosed).length, 1);
  check(
    "the other is shown the box closed, not told it closed it",
    both.filter((o) => !autoClosed(o)).map((o) => (o.kind === "box" ? o.box.status : o.kind)),
    ["CLOSED_COMPLETE"],
  );

  /* ------------------------------------- the day marked sent, then Undo */

  console.log("\nUndo after the day is marked sent.");
  // A day of its own, years back, so marking it sent touches only this box.
  const sentDay = toDbDate("2020-01-02");
  const sent = await prisma.package.create({
    data: {
      trackingNumber: label(11),
      platform: "TIKTOK",
      showDate: sentDay,
      buyer: BUYER,
      items: { create: [{ stockNumber: "80012", expectedQty: 1, scannedQty: 0 }] },
    },
    select: { id: true },
  });
  await prisma.package.create({
    data: { trackingNumber: label(12), platform: "TIKTOK", showDate: sentDay, buyer: BUYER,
      items: { create: [{ stockNumber: "80013", expectedQty: 1, scannedQty: 0 }] } },
  });
  await openBoxByScan(packer.id, label(11));
  await packItem(packer.id, sent.id, "80012");
  await markDaySent(other.id, sentDay, "check-auto-close: day marked sent");
  check("Undo is refused once the day is marked sent", (await undoAutoClose(packer.id, sent.id)).kind, "error");
  check(
    "and the box stays closed",
    (await prisma.package.findUniqueOrThrow({ where: { id: sent.id }, select: { status: true } })).status,
    "CLOSED_COMPLETE",
  );
} finally {
  console.log("\nCleaning up.");
  await cleanUp();
  const left = await prisma.package.count({ where: { trackingNumber: { in: LABELS } } });
  console.log(`Removed — ${left} fixture box(es) left.`);
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll auto-close checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

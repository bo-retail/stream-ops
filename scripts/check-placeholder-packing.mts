/**
 * Packs the real 09/15 diamond placeholders, against a real database.
 *
 * TikTok caps a live at 100 listed items, so the extras are sold under
 * stand-in listings and switched to their real SKU after the show. The export
 * does not wait for the switch: on 09/15 eight paid boxes held a single line
 * reading "LGD - As seen on screen - No returns or cancellations", printed on
 * nothing, and every one of them could only close incomplete.
 *
 * Now the packer scans the tag on the piece. These checks walk the real file
 * through every rule that makes that safe rather than a hole in the wrong-box
 * check: a misread is refused, a piece on another customer's order is refused,
 * a piece already packed as somebody else's is refused, the real piece is
 * recorded against the order, and nothing about an ordinary box changes.
 *
 *   DIAMOND_EXPORT=<the 09/15 diamond export> \
 *   DATABASE_URL=<a development database> \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/check-placeholder-packing.mts
 *
 * Refuses to start if 09/15 already has diamond boxes, so it can only ever
 * remove what it made itself.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import { isPlaceholderStock } from "../src/lib/domain/imports/placeholders";
import { runImport } from "../src/lib/server/imports";
import {
  getBoxById,
  getBoxScans,
  getPackerDays,
  openBoxByScan,
  packItem,
  sealBox,
} from "../src/lib/server/packing";
import type { ScanOutcome } from "../src/lib/server/packing";

assertDevDatabase("check-placeholder-packing.mts");

const diamondPath = process.env.DIAMOND_EXPORT;
if (!diamondPath || !existsSync(diamondPath)) {
  console.log("SKIP  needs DIAMOND_EXPORT (the 09/15 diamond export).");
  await prisma.$disconnect();
  process.exit(0);
}

const DAY = "2026-09-15";
const showDate = toDbDate(DAY);
const mine = { business: "DIAMOND" as const, showDate };

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

function boxOf(outcome: ScanOutcome) {
  return outcome.kind === "box" || outcome.kind === "refused" || outcome.kind === "alreadyPacked"
    ? outcome.box
    : null;
}

async function cleanUp() {
  await prisma.scanEvent.deleteMany({ where: { package: mine } });
  await prisma.packageItem.deleteMany({ where: { package: mine } });
  await prisma.package.deleteMany({ where: mine });
  await prisma.importBatch.deleteMany({ where: mine });
}

if ((await prisma.package.count({ where: mine })) > 0) {
  console.log(`REFUSED  ${DAY} already has diamond boxes in this database. Not touching them.`);
  await prisma.$disconnect();
  process.exit(1);
}

const packer = await prisma.user.findFirstOrThrow({
  where: { role: "BOSS", isActive: true },
  select: { id: true },
});

try {
  /* ------------------------------------------------------------ the upload */

  const imported = await runImport(
    [{ name: "diamond.csv", text: readFileSync(diamondPath, "utf8") }],
    packer.id,
  );
  check("the real diamond export is accepted", imported.status, "OK");
  check(
    "and says at upload that some pieces were sold under a placeholder listing",
    imported.flags.some((f) => f.severity === "info" && f.message.includes("8 piece(s) were sold under a placeholder")),
    true,
  );
  check(
    "without the false alarm about 36 unreadable show tags",
    imported.flags.some((f) => f.message.includes("unreadable shift tag")),
    false,
  );

  const boxes = await prisma.package.findMany({
    where: mine,
    select: { id: true, trackingNumber: true, items: { select: { stockNumber: true } } },
    orderBy: { trackingNumber: "asc" },
  });
  const placeholderBoxes = boxes.filter((b) => b.items.some((i) => isPlaceholderStock(i.stockNumber)));
  check("eight boxes hold a placeholder, as the file says", placeholderBoxes.length, 8);

  const ordinary = boxes.find(
    (b) => b.items.length === 1 && !isPlaceholderStock(b.items[0].stockNumber),
  )!;
  const OTHER_ORDERS_PIECE = ordinary.items[0].stockNumber;

  const [p1, p2] = placeholderBoxes;

  /* ---------------------------------------------------- the first box */

  const opened = await openBoxByScan(packer.id, p1.trackingNumber);
  const view = boxOf(opened)!;
  check("the label opens the placeholder box", opened.kind, "box");
  check("its line is shown as a placeholder listing", view.items[0].placeholder, true);
  check("waiting for one piece", view.items[0].outstanding, 1);

  const misread = await packItem(packer.id, p1.id, "WYZ.");
  check("a misread is refused rather than recorded as the piece", misread.kind, "refused");
  check(
    "and is not offered as something to add",
    misread.kind === "refused" ? [misread.unreadable, misread.stockNumber] : null,
    [true, undefined],
  );

  /*
    The check that matters. The placeholder would take any tag, so without this
    another customer's piece goes in the box and it closes complete.
  */
  const wrongPiece = await packItem(packer.id, p1.id, OTHER_ORDERS_PIECE);
  check("a piece on another customer's order is refused", wrongPiece.kind, "refused");
  check(
    "and says whose box it belongs to",
    wrongPiece.kind === "refused" && wrongPiece.message.includes(ordinary.trackingNumber),
    true,
  );
  check("nothing went in the box", boxOf(wrongPiece)!.items[0].scanned, 0);

  const filled = await packItem(packer.id, p1.id, "TAG-90001");
  const afterFill = boxOf(filled)!;
  check("the real tag is recorded as this customer's piece", filled.kind, "box");
  check("against the placeholder line", afterFill.items[0].pieces, ["TAG-90001"]);
  check("which makes the box complete", afterFill.complete, true);

  const closed = await sealBox(packer.id, p1.id, false);
  check("and it closes complete by the ordinary route", boxOf(closed)?.status, "CLOSED_COMPLETE");

  const history = await getBoxScans(p1.id);
  const recorded = history.find((s) => s.kind === "ITEM_PLACEHOLDER");
  check("the box history names the real piece", recorded?.stockNumber, "TAG-90001");
  check(
    "and the listing it was sold as",
    recorded?.note,
    `Sold as: ${placeholderBoxes[0].items[0].stockNumber}`,
  );
  check(
    "and keeps the refusals, which prove the check worked",
    history.filter((s) => s.kind === "ITEM_REFUSED").length,
    2,
  );

  /* --------------------------------------------------- the second box */

  await openBoxByScan(packer.id, p2.trackingNumber);

  const samePiece = await packItem(packer.id, p2.id, "TAG-90001");
  check("a piece already packed as somebody else's is refused", samePiece.kind, "refused");
  check(
    "naming the box it went into",
    samePiece.kind === "refused" && samePiece.message.includes(p1.trackingNumber),
    true,
  );

  const second = await packItem(packer.id, p2.id, "TAG-90002");
  check("a different piece fills the second box", boxOf(second)?.items[0].pieces, ["TAG-90002"]);

  const again = await packItem(packer.id, p2.id, "TAG-90003");
  check("once filled, a further tag is not squeezed into it", again.kind, "refused");

  /* ----------------------------------------- an ordinary box is unchanged */

  await openBoxByScan(packer.id, ordinary.trackingNumber);
  const normal = await packItem(packer.id, ordinary.id, OTHER_ORDERS_PIECE);
  check("an ordinary diamond box still scans by its stock number", boxOf(normal)?.complete, true);
  check("and records nothing as a placeholder", boxOf(normal)?.items[0].placeholder, false);

  /* ---------------------------------------------------- the tallies */

  const tally = (await getPackerDays(showDate)).find((d) => d.userId === packer.id);
  check("the packer is credited with all three pieces, placeholders included", tally?.items, 3);

  /* ------------------------------------------- uploading the day again */

  // The morning's file is sometimes sent again, for a late label. Packed boxes
  // must come through it exactly as they were — piece and all.
  const reuploaded = await runImport(
    [{ name: "diamond.csv", text: readFileSync(diamondPath, "utf8") }],
    packer.id,
  );
  check("the same file can be sent again", reuploaded.status, "OK");
  const survived = await getBoxById(p1.id);
  check("the packed box is still closed", survived?.status, "CLOSED_COMPLETE");
  check("and still names its piece", survived?.items[0].pieces, ["TAG-90001"]);
  const stillOpen = await getBoxById(p2.id);
  check("an open box keeps its piece too", stillOpen?.items[0].pieces, ["TAG-90002"]);
} finally {
  console.log("\nCleaning up.");
  await cleanUp();
  console.log(`Removed — ${await prisma.package.count({ where: mine })} diamond box(es) left on ${DAY}.`);
  await prisma.$disconnect();
}

console.log(
  failures === 0 ? "\nAll placeholder-packing checks passed." : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);

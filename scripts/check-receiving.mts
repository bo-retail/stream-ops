/**
 * Inventory step 2 — receiving — against a real database.
 *
 * The situations it will meet, run rather than reasoned about:
 *
 *   - the real 09.19 offer and 9.16 shipping list, read as the site reads them
 *   - an offer creating new models inactive, filling blanks on known ones and
 *     never overwriting a cost; the same date uploaded again replaces it
 *   - a shipping list: nothing in stock until counted; uploaded twice before
 *     its count replaces, after its count is refused
 *   - a count: good pieces to Sellable, damaged to Damaged, cost averaged, the
 *     model made active; the same count twice moves nothing; a correction
 *     moves only the difference and puts the cost back
 *   - short, over, damaged, a model not on the list, a listed model counted 0
 *   - a difference settled; a recount after settling reopens it, the same
 *     numbers again do not
 *   - two people saving the same shipment's count at once; a page opened
 *     before somebody else's count, saved after it: refused
 *   - the count sheet downloaded, filled in and uploaded; an old sheet after a
 *     newer count: refused; its SOP cells cleared: still its own shipment
 *   - a typo in "a model not on the list": refused unless ticked as new
 *   - a count finished with models not counted: they are short
 *   - a list naming one counted SOP and one new: refused whole
 *   - an ordered model arriving off-list, or found at a shelf count
 *   - product details: typed, uploaded, a blank keeps, a cost kept, a barcode
 *     Excel damaged refused, a model not in the catalogue refused
 *   - still to come
 *   - a counted shipment cannot be deleted out from under its stock
 *
 * Every model it makes starts ZZTEST-, every SOP ZZTEST-, and all of it is
 * removed at the end. Optional, with the real files: STREAMOPS_OFFER_FILE and
 * STREAMOPS_SHIPPING_LIST (read only — nothing from them is saved).
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-receiving.mts
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { addDays, toDbDate, todayISO } from "../src/lib/domain/dates";
import type { Cell, SheetRows } from "../src/lib/domain/inventory-sheets";
import { sheetRows } from "../src/lib/domain/inventory-sheets";
import { isOfferColumn, isOfferHeading, isShippingListHeading, readOffer, readShippingList } from "../src/lib/domain/receiving";
import { getModel, importMaster, saveCount, setImageUrl } from "../src/lib/server/inventory";
import { readDetailsSheet, detailsSheet, saveDetails } from "../src/lib/server/product-details";
import {
  finishShipmentCount,
  getReceiving,
  getShipment,
  importOffer,
  importShippingList,
  readShipmentCountSheet,
  saveShipmentCount,
  settleDifference,
  shipmentCountSheet,
} from "../src/lib/server/receiving";
import { getSettings } from "../src/lib/server/settings";

assertDevDatabase("check-receiving.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const P = "ZZTEST-";
const SOP1 = `${P}SOP1`;
const SOP2 = `${P}SOP2`;

async function cleanUp() {
  const products = (await prisma.product.findMany({ where: { model: { startsWith: P } }, select: { id: true } })).map((p) => p.id);
  const shipments = (await prisma.shipment.findMany({ where: { sop: { startsWith: P } }, select: { id: true } })).map((s) => s.id);
  // Only a test may remove stock history, and only its own.
  await prisma.stockMove.deleteMany({ where: { OR: [{ productId: { in: products } }, { shipmentId: { in: shipments } }] } });
  await prisma.shipmentLine.deleteMany({ where: { OR: [{ productId: { in: products } }, { shipmentId: { in: shipments } }] } });
  await prisma.shipment.deleteMany({ where: { id: { in: shipments } } });
  const offers = (await prisma.offer.findMany({ where: { fileName: { startsWith: P } }, select: { id: true } })).map((o) => o.id);
  await prisma.offerLine.deleteMany({ where: { OR: [{ productId: { in: products } }, { offerId: { in: offers } }] } });
  await prisma.offer.deleteMany({ where: { id: { in: offers } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...products, ...shipments, ...offers] } } });
  await prisma.product.deleteMany({ where: { id: { in: products } } });
}

const sheet = (rows: Record<string, Cell>[], name = "Sheet1"): SheetRows => [{ sheet: name, rows: rows.map((values, i) => ({ line: i + 2, values })) }];
const offerRow = (model: string, dani: number | null, cost: number, extra: Record<string, Cell> = {}) => ({
  "Invicta Model": model, Brand: "Invicta", Collection: "Pro Diver", Gender: "Men", Dani: dani, "BO COSTS": cost, ...extra,
});
const listRow = (sop: string, item: string, qty: number, price: number) => ({ "SOP Number": sop, "Customer PO Number": "TEST ORDER", Item: item, Quantity: qty, "Unit Price": price });

const product = (model: string) => prisma.product.findUniqueOrThrow({ where: { model } });
const stock = async (model: string) => (await getModel(model))!.balances;
const movesOf = async (sop: string) => prisma.stockMove.count({ where: { shipment: { sop } } });

const boss = await prisma.user.findFirst({ where: { role: "BOSS", isActive: true }, select: { id: true } });
if (!boss) {
  console.log("SKIP  needs an admin account. Run the seed first.");
  await prisma.$disconnect();
  process.exit(0);
}
const today = todayISO((await getSettings()).timezone);
// A date no real offer uses, inside the still-to-come window.
let offerDate = addDays(today, -59);
while (await prisma.offer.findUnique({ where: { date: toDbDate(offerDate) } })) offerDate = addDays(offerDate, 1);

try {
  await cleanUp();

  /* ----------------------------------------------------------- real files */

  const offerPath = process.env.STREAMOPS_OFFER_FILE;
  if (offerPath && existsSync(offerPath)) {
    console.log("The real offer (read only).");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(offerPath));
    const rows = sheetRows(wb, isOfferHeading, isOfferColumn);
    const r = readOffer(rows);
    check("every line Daniel ordered is read, with nothing refused", [r.lines.length, r.problems], [426, []]);
    check("  25,691 pieces ordered", r.lines.reduce((n, l) => n + l.qty, 0), 25691);
    const kb = Math.round(JSON.stringify(rows).length / 1024);
    console.log(`      (as rows it is ${kb} KB, from a ${Math.round(readFileSync(offerPath).length / 1024 / 1024)} MB file)`);
    check("  as rows it fits well under what the site accepts", kb < 3000, true);
  } else console.log("SKIP  real offer: set STREAMOPS_OFFER_FILE.");
  const listPath = process.env.STREAMOPS_SHIPPING_LIST;
  if (listPath && existsSync(listPath)) {
    console.log("The real shipping list (read only).");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(listPath));
    const r = readShippingList(sheetRows(wb, isShippingListHeading));
    const s = r.shipments[0];
    check("one SOP, 91 models, 2,937 pieces, $86,846 at cost, nothing refused", [
      r.shipments.length, s?.sop, s?.lines.length, s?.lines.reduce((n, l) => n + l.qty, 0),
      s ? Math.round(s.lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0) / 100) : 0, r.problems,
    ], [1, "INV258905", 91, 2937, 86846, []]);
  } else console.log("SKIP  real shipping list: set STREAMOPS_SHIPPING_LIST.");

  /* ------------------------------------------------------------------ offer */

  console.log("\nThe offer.");
  // A model the app already knows, with a cost and a collection of its own.
  await prisma.product.create({ data: { model: `${P}K100`, collection: "Bolt", costCents: 2500, description: "Known watch" } });
  const o1 = await importOffer(boss.id, `${P}offer.xlsx`, offerDate, sheet([
    offerRow(`${P}NEW1`, 10, 30, { "Small Main Image": "https://cdn.invictawatch.com/x.jpg" }),
    offerRow(`${P}NEW2`, 4, 50),
    offerRow(`${P}K100`, 6, 28),
    offerRow(`${P}S100`, 0, 30),
  ]));
  check("the lines he ordered are saved; a 0 is skipped", [o1.ok, o1.lines, o1.pieces, o1.created], [true, 3, 20, [`${P}NEW1`, `${P}NEW2`]]);
  const n1 = await product(`${P}NEW1`);
  check("a new model is created inactive, flagged, with the offer's cost, brand and picture", [n1.active, n1.needsDetails, n1.costCents, n1.brand, n1.imageUrl], [false, true, 3000, "Invicta", "https://cdn.invictawatch.com/x.jpg"]);
  const k1 = await product(`${P}K100`);
  check("a known model keeps its cost and collection; only blanks are filled", [k1.costCents, k1.collection, k1.brand, k1.active], [2500, "Bolt", "Invicta", true]);
  check("a model ordered 0 is not created", await prisma.product.count({ where: { model: `${P}S100` } }), 0);
  const o2 = await importOffer(boss.id, `${P}offer-fixed.xlsx`, offerDate, sheet([offerRow(`${P}NEW1`, 12, 30), offerRow(`${P}NEW2`, 4, 50), offerRow(`${P}K100`, 6, 28)]));
  check("the same date again replaces it, not adds to it", [o2.replaced, (await prisma.offer.findUniqueOrThrow({ where: { date: toDbDate(offerDate) }, include: { lines: true } })).lines.reduce((n, l) => n + l.qty, 0)], [true, 22]);
  const bad = await importOffer(boss.id, `${P}offer-bad.xlsx`, addDays(offerDate, -1), sheet([offerRow(`${P}NEW3`, 5, 30), { "Invicta Model": `${P}NEW4`, Dani: "#N/A", "BO COSTS": 30 }]));
  check("an offer with an unreadable line saves nothing", [bad.ok, await prisma.product.count({ where: { model: `${P}NEW3` } })], [false, 0]);

  /* ----------------------------------------------------------- shipping list */

  console.log("\nThe shipping list.");
  const l1 = await importShippingList(boss.id, `${P}list.xlsx`, sheet([
    listRow(SOP1, `${P}NEW1`, 10, 32), listRow(SOP1, `${P}NEW2`, 4, 50), listRow(SOP1, `${P}K100`, 6, 30), listRow(SOP1, `${P}L100`, 2, 20),
  ]));
  check("loaded, with a model never seen before created for counting", [l1.ok, l1.shipments[0]?.pieces, l1.created], [true, 22, [`${P}L100`]]);
  check("nothing is in stock yet", [(await stock(`${P}NEW1`)).SELLABLE, await movesOf(SOP1)], [0, 0]);
  const l2 = await importShippingList(boss.id, `${P}list-fixed.xlsx`, sheet([
    listRow(SOP1, `${P}NEW1`, 10, 32), listRow(SOP1, `${P}NEW2`, 4, 50), listRow(SOP1, `${P}K100`, 6, 30), listRow(SOP1, `${P}L100`, 3, 20),
  ]));
  check("the same SOP before it is counted: replaced", [l2.ok, l2.shipments[0]?.replaced, (await getShipment(SOP1))!.lines.length], [true, true, 4]);

  /* ---------------------------------------------------------------- count */

  console.log("\nCounting it in.");
  const c1 = await saveShipmentCount(boss.id, SOP1, [
    { model: `${P}NEW1`, counted: 8, damaged: 1 }, // short 2, 1 damaged
    { model: `${P}K100`, counted: 7, damaged: 0 }, // over 1
  ], "check");
  check("a first, partial count saves", [c1.ok, c1.changed, c1.activated], [true, 2, [`${P}NEW1`]]);
  check("good pieces go to Sellable, damaged to Damaged", [(await stock(`${P}NEW1`)).SELLABLE, (await stock(`${P}NEW1`)).DAMAGED], [7, 1]);
  check("the new model is now active", (await product(`${P}NEW1`)).active, true);
  check("a model with nothing on hand takes the shipping-list price", (await product(`${P}NEW1`)).costCents, 3200);
  check("a model with a cost but nothing on hand takes the new price ($30)", (await product(`${P}K100`)).costCents, 3000);
  const receivedLine = await prisma.stockMove.findFirstOrThrow({ where: { shipment: { sop: SOP1 }, product: { model: `${P}NEW1` }, place: "SELLABLE" } });
  check("each receipt carries its cost and its shipment", [receivedLine.kind, receivedLine.unitCostCents], ["RECEIVED", 3200]);

  const again = await saveShipmentCount(boss.id, SOP1, [{ model: `${P}NEW1`, counted: 8, damaged: 1 }], "check");
  check("the same count saved twice moves nothing", [again.ok, again.changed, await movesOf(SOP1)], [true, 0, 3]);

  // Weighted average: KNOWN has 7 at $30; 5 more counted on a second shipment at $40.
  await importShippingList(boss.id, `${P}list2.xlsx`, sheet([listRow(SOP2, `${P}K100`, 5, 40)]));
  await saveShipmentCount(boss.id, SOP2, [{ model: `${P}K100`, counted: 5, damaged: 0 }], "check");
  check("more of a model at another price: the cost is the weighted average", (await product(`${P}K100`)).costCents, Math.round((3000 * 7 + 4000 * 5) / 12));
  await saveShipmentCount(boss.id, SOP2, [{ model: `${P}K100`, counted: 0, damaged: 0 }], "check");
  check("counted back to 0: stock goes back, and the cost to within a cent", [(await stock(`${P}K100`)).SELLABLE, Math.abs((await product(`${P}K100`)).costCents! - 3000) <= 1], [7, true]);

  const fix = await saveShipmentCount(boss.id, SOP1, [{ model: `${P}NEW1`, counted: 10, damaged: 0 }], "check");
  check("a corrected count moves only the difference", [fix.ok, (await stock(`${P}NEW1`)).SELLABLE, (await stock(`${P}NEW1`)).DAMAGED], [true, 10, 0]);

  const typo = await saveShipmentCount(boss.id, SOP1, [{ model: `${P}NEW2`, counted: 4, damaged: 0 }, { model: `${P}E100`, counted: 2, damaged: 0 }], "check");
  check("a model nobody has heard of, not ticked as new: refused, nothing saved", [typo.ok, await prisma.product.count({ where: { model: `${P}E100` } }), (await stock(`${P}NEW2`)).SELLABLE], [false, 0, 0]);
  const notListed = await saveShipmentCount(boss.id, SOP1, [{ model: `${P}NEW2`, counted: 4, damaged: 0 }, { model: `${P}E100`, counted: 2, damaged: 0, allowNew: true }, { model: `${P}L100`, counted: 0, damaged: 0 }], "check");
  check("a model not on the list is added and counted in", [notListed.ok, notListed.notOnList, (await stock(`${P}E100`)).SELLABLE], [true, [`${P}E100`], 2]);
  check("  it has no price, so it gets none (and no cost)", (await product(`${P}E100`)).costCents, null);
  await saveShipmentCount(boss.id, SOP2, [{ model: `${P}NEW2`, counted: 1, damaged: 0 }], "check");
  check("a model not on the list but on the offer takes the offer's cost ($50)", (await getShipment(SOP2))!.lines.find((l) => l.product.model === `${P}NEW2`)?.unitCostCents, 5000);
  await saveShipmentCount(boss.id, SOP2, [{ model: `${P}NEW2`, counted: 0, damaged: 0 }], "check");

  const refused = await importShippingList(boss.id, `${P}list-late.xlsx`, sheet([listRow(SOP1, `${P}NEW1`, 99, 32)]));
  check("the shipping list again after it is counted: refused", [refused.ok, (await getShipment(SOP1))!.lines.find((l) => l.product.model === `${P}NEW1`)?.listedQty], [false, 10]);

  const mixed = await importShippingList(boss.id, `${P}list-mixed.xlsx`, sheet([listRow(SOP1, `${P}NEW1`, 10, 32), listRow(`${P}SOP4`, `${P}NEW1`, 2, 32)]));
  check("a list with a counted SOP and a new one: refused whole, the new one not created", [mixed.ok, await prisma.shipment.count({ where: { sop: `${P}SOP4` } })], [false, 0]);

  const tooMany = await saveShipmentCount(boss.id, SOP1, [{ model: `${P}NEW2`, counted: 2, damaged: 3 }], "check");
  check("more damaged than counted: nothing saved", [tooMany.ok, (await stock(`${P}NEW2`)).SELLABLE], [false, 4]);
  const noShipment = await saveShipmentCount(boss.id, `${P}X999`, [{ model: `${P}NEW2`, counted: 1, damaged: 0 }], "check");
  check("a shipment that does not exist: refused", noShipment.ok, false);

  /* ---------------------------------------------------------- differences */

  console.log("\nDifferences with Invicta.");
  const r1 = await getReceiving();
  const open = r1.differences.filter((d) => d.sop === SOP1).map((d) => `${d.model}:${d.kinds.map((k) => `${k.qty} ${k.kind}`).join("+")}`).sort();
  check("over, not on the list, and a listed model counted 0 are open", open, [`${P}E100:2 not on the list`, `${P}K100:1 over`, `${P}L100:3 short`].sort());
  const knownLine = r1.differences.find((d) => d.model === `${P}K100` && d.sop === SOP1)!;
  check("settled, it leaves the list", [(await settleDifference(boss.id, knownLine.lineId, "Invicta fixed the invoice")).ok, (await getReceiving()).differences.some((d) => d.lineId === knownLine.lineId)], [true, false]);
  await saveShipmentCount(boss.id, SOP1, [{ model: `${P}K100`, counted: 8, damaged: 0 }], "check");
  check("a recount after settling reopens it, on the new numbers", (await getReceiving()).differences.find((d) => d.lineId === knownLine.lineId)?.kinds, [{ kind: "over", qty: 2 }]);
  await settleDifference(boss.id, knownLine.lineId, "invoice fixed again");
  await saveShipmentCount(boss.id, SOP1, [{ model: `${P}K100`, counted: 8, damaged: 0 }], "check");
  check("the same numbers saved again leave it settled", (await getReceiving()).differences.some((d) => d.lineId === knownLine.lineId), false);

  /* ------------------------------------------------------- two at once */

  console.log("\nTwo people saving the same shipment at once.");
  const both = await Promise.all([
    saveShipmentCount(boss.id, SOP1, [{ model: `${P}NEW2`, counted: 3, damaged: 1 }], "a"),
    saveShipmentCount(boss.id, SOP1, [{ model: `${P}NEW2`, counted: 3, damaged: 1 }], "b"),
  ]);
  check("both are answered, and stock is what they counted, not double", [both.map((b) => b.ok), (await stock(`${P}NEW2`)).SELLABLE, (await stock(`${P}NEW2`)).DAMAGED], [[true, true], 2, 1]);
  // Gladys's page opened when K100 stood at 8. Andres then saves 9. Gladys saves 7.
  await saveShipmentCount(boss.id, SOP1, [{ model: `${P}K100`, counted: 9, damaged: 0, before: { counted: 8, damaged: 0 } }], "Andres");
  const stale = await saveShipmentCount(boss.id, SOP1, [{ model: `${P}K100`, counted: 7, damaged: 0, before: { counted: 8, damaged: 0 } }], "Gladys");
  check("a page opened before somebody else's count: refused, theirs kept", [stale.ok, (await stock(`${P}K100`)).SELLABLE, stale.problems[0]?.includes("somebody else")], [false, 9, true]);
  const fresh = await saveShipmentCount(boss.id, SOP1, [{ model: `${P}K100`, counted: 8, damaged: 0, before: { counted: 9, damaged: 0 } }], "Gladys");
  check("  after a refresh, her count saves", [fresh.ok, (await stock(`${P}K100`)).SELLABLE], [true, 8]);
  // A second delivery added as "a model not on the list" for a model already counted.
  const asExtra = await saveShipmentCount(boss.id, SOP1, [{ model: `${P}K100`, counted: 4, damaged: 0, before: null }], "page");
  check("a model already counted, added again as not on the list: refused, its total kept", [asExtra.ok, (await stock(`${P}K100`)).SELLABLE, asExtra.problems[0]?.includes("already on this shipment")], [false, 8, true]);

  /* ------------------------------------------------------ the count sheet */

  console.log("\nThe shipment count sheet.");
  // A model the app knows (from an earlier offer) that turns up on the sheet.
  await prisma.product.create({ data: { model: `${P}N300`, description: "Known, not on this list" } });
  const blank = await shipmentCountSheet(SOP1);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(blank!);
  const ws = wb.worksheets[0];
  ws.eachRow((row, n) => {
    if (n <= 2) return;
    if (String(row.getCell(2).value) === `${P}L100`) row.getCell(5).value = 3;
  });
  ws.addRow([SOP1, `${P}N300`, "", null, 1, null]);
  const read = await readShipmentCountSheet((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  check("downloaded, filled in, read back: its SOP and the counts", [read.sop, read.problems, read.entries.find((e) => e.model === `${P}L100`)?.counted], [SOP1, [], 3]);
  const viaSheet = await saveShipmentCount(boss.id, read.sop, read.entries, "sheet");
  check("uploaded: the short is made up, and a row added at the bottom comes in", [viaSheet.ok, (await stock(`${P}L100`)).SELLABLE, (await stock(`${P}N300`)).SELLABLE], [true, 3, 1]);
  check("  uploading the same sheet twice moves nothing more", [(await saveShipmentCount(boss.id, read.sop, read.entries, "sheet", { sheetDownloadedAt: read.downloadedAt })).changed, (await stock(`${P}L100`)).SELLABLE], [0, 3]);

  // An old sheet: downloaded, then the count changes on the page, then the old sheet comes back.
  const oldBuf = await shipmentCountSheet(SOP1);
  await new Promise((r) => setTimeout(r, 20));
  await saveShipmentCount(boss.id, SOP1, [{ model: `${P}L100`, counted: 2, damaged: 0 }], "page");
  const oldWb = new ExcelJS.Workbook();
  await oldWb.xlsx.load(oldBuf!);
  const oldRead = await readShipmentCountSheet((await oldWb.xlsx.writeBuffer()) as ArrayBuffer);
  const old = await saveShipmentCount(boss.id, oldRead.sop, oldRead.entries, "sheet", { sheetDownloadedAt: oldRead.downloadedAt });
  check("an old sheet after a newer count: refused, the newer count kept", [old.ok, (await stock(`${P}L100`)).SELLABLE], [false, 2]);

  // The SOP cells cleared: the tab's name still says which shipment it is.
  const cleared = new ExcelJS.Workbook();
  await cleared.xlsx.load((await shipmentCountSheet(SOP1))!);
  cleared.worksheets[0].eachRow((row, n) => { if (n > 2) row.getCell(1).value = null; });
  check("its SOP cells cleared: still read as its own shipment", (await readShipmentCountSheet((await cleared.xlsx.writeBuffer()) as ArrayBuffer)).sop, SOP1);

  // A typo added at the bottom of the sheet.
  const typoWb = new ExcelJS.Workbook();
  await typoWb.xlsx.load((await shipmentCountSheet(SOP1))!);
  typoWb.worksheets[0].addRow([SOP1, `${P}T404`, "", null, 1, null]);
  const typoRead = await readShipmentCountSheet((await typoWb.xlsx.writeBuffer()) as ArrayBuffer);
  check("a model nobody has heard of on the sheet: refused", [(await saveShipmentCount(boss.id, typoRead.sop, typoRead.entries, "sheet", { sheetDownloadedAt: typoRead.downloadedAt })).ok, await prisma.product.count({ where: { model: `${P}T404` } })], [false, 0]);

  /* -------------------------------------------------------- finishing */

  console.log("\nFinishing a count with models not counted.");
  await importShippingList(boss.id, `${P}list3.xlsx`, sheet([listRow(`${P}SOP3`, `${P}K100`, 2, 32), listRow(`${P}SOP3`, `${P}NEW2`, 3, 50)]));
  await saveShipmentCount(boss.id, `${P}SOP3`, [{ model: `${P}K100`, counted: 2, damaged: 0 }], "check");
  check("part-counted: being counted, the rest not short yet", [(await getReceiving()).shipments.find((s) => s.sop === `${P}SOP3`)?.uncounted, (await getReceiving()).differences.some((d) => d.sop === `${P}SOP3`)], [1, false]);
  const fin = await finishShipmentCount(boss.id, `${P}SOP3`);
  check("finished: what was not counted is short", [fin.ok, (await getReceiving()).differences.filter((d) => d.sop === `${P}SOP3`).map((d) => `${d.model}:${d.kinds[0].qty} ${d.kinds[0].kind}`)], [true, [`${P}NEW2:3 short`]]);
  await saveShipmentCount(boss.id, `${P}SOP3`, [{ model: `${P}K100`, counted: 0, damaged: 0 }], "check");

  /* ------------------------------------------------------ product details */

  console.log("\nProduct details.");
  const d1 = await saveDetails(boss.id, [{ model: `${P}NEW1`, values: { Description: "Pro Diver 40mm, blue", TP: 45, "Weight (lb)": 0.8, "Length (in)": 6, "Width (in)": 4, "Height (in)": 3, "eBay shipping profile": "Watch small", UPC: "886678123456", Cost: 99 } }], "check");
  const nd = await product(`${P}NEW1`);
  check("details typed in are saved and the flag goes", [d1.ok, nd.description, nd.tpCents, nd.weightLb, nd.upc, nd.needsDetails], [true, "Pro Diver 40mm, blue", 4500, 0.8, "886678123456", false]);
  check("  but a cost already set is kept, and said so", [nd.costCents, d1.costKept], [3200, [`${P}NEW1`]]);
  check("a blank keeps what is there", [(await saveDetails(boss.id, [{ model: `${P}NEW1`, values: { Description: "", TP: null } }], "check")).ok, (await product(`${P}NEW1`)).description], [true, "Pro Diver 40mm, blue"]);
  check("a barcode Excel turned into 8.87E+11: refused", (await saveDetails(boss.id, [{ model: `${P}NEW1`, values: { UPC: "8.87E+11" } }], "check")).ok, false);
  check("a model not in the catalogue: refused", (await saveDetails(boss.id, [{ model: `${P}X999`, values: { Description: "x" } }], "check")).ok, false);
  check("a price that is not a price: refused, nothing saved", [(await saveDetails(boss.id, [{ model: `${P}NEW1`, values: { TP: "forty", Description: "changed" } }], "check")).ok, (await product(`${P}NEW1`)).description], [false, "Pro Diver 40mm, blue"]);
  check("a missing cost is filled", [(await saveDetails(boss.id, [{ model: `${P}E100`, values: { Cost: 12.5 } }], "check")).ok, (await product(`${P}E100`)).costCents], [true, 1250]);
  console.log("\nThe master loaded again after details were typed in the app.");
  await setImageUrl(boss.id, `${P}NEW1`, "https://cdn.invictawatch.com/typed.jpg");
  await importMaster(boss.id, `${P}master.xlsx`, sheet([{
    "Invicta Model": `${P}NEW1`, Description: "Invicta's own words", TP: 99, Collection: "Venom", URL: "https://cdn.invictawatch.com/master.jpg", "eBay Shipping Profile Name": "Master profile",
  }], "Inventory"));
  const afterMaster = await product(`${P}NEW1`);
  check("what the team typed is kept: description, target price, profile, picture link", [afterMaster.description, afterMaster.tpCents, afterMaster.ebayShippingProfile, afterMaster.imageUrl], ["Pro Diver 40mm, blue", 4500, "Watch small", "https://cdn.invictawatch.com/typed.jpg"]);
  check("what nobody typed still comes from the master", afterMaster.collection, "Venom");

  const sheetBuf = await detailsSheet();
  const back = await readDetailsSheet(sheetBuf);
  const mine = back.entries.filter((e) => String(e.values.Model).startsWith(P));
  check("the details sheet downloaded and uploaded unchanged changes nothing", (await saveDetails(boss.id, mine, "sheet")).updated, []);

  /* --------------------------------------------------------- still to come */

  console.log("\nStill to come.");
  const toCome = (await getReceiving()).toCome.filter((t) => t.model.startsWith(P));
  check("ordered on the offer, minus what the shipping lists sent since", toCome.map((t) => `${t.model}:${t.toCome}`).sort(), [`${P}NEW1:2`].sort());
  await saveShipmentCount(boss.id, SOP2, [{ model: `${P}NEW1`, counted: 2, damaged: 0 }], "check");
  check("the balance arriving off-list on a later shipment: nothing left to come", (await getReceiving()).toCome.filter((t) => t.model.startsWith(P)), []);

  console.log("\nAn ordered model found at a shelf count.");
  await importOffer(boss.id, `${P}offer-shelf.xlsx`, addDays(offerDate, -3), sheet([offerRow(`${P}SHELF1`, 5, 30)]));
  check("  inactive after the offer", (await product(`${P}SHELF1`)).active, false);
  await saveCount(boss.id, [{ model: `${P}SHELF1`, counted: { SELLABLE: 2 } }], "check");
  check("  counted on the shelf, it is active", (await product(`${P}SHELF1`)).active, true);
  await importOffer(boss.id, `${P}offer-shelf2.xlsx`, addDays(offerDate, -4), sheet([offerRow(`${P}SHELF2`, 5, 30)]));
  await saveCount(boss.id, [{ model: `${P}SHELF2`, counted: { DAMAGED: 1 } }], "check");
  check("  found only damaged, it stays not arrived", (await product(`${P}SHELF2`)).active, false);

  console.log("\nA picture link cleared.");
  await setImageUrl(boss.id, `${P}NEW1`, "");
  await importMaster(boss.id, `${P}master-2.xlsx`, sheet([{ "Invicta Model": `${P}NEW1`, URL: "https://cdn.invictawatch.com/master.jpg" }], "Inventory"));
  check("  cleared, the master may fill it again", (await product(`${P}NEW1`)).imageUrl, "https://cdn.invictawatch.com/master.jpg");

  /* --------------------------------------------- history cannot be deleted */

  let blocked = false;
  try {
    await prisma.shipment.delete({ where: { sop: SOP1 } });
  } catch {
    blocked = true;
  }
  check("a counted shipment cannot be deleted out from under its stock", blocked, true);
} finally {
  console.log("\nCleaning up.");
  await cleanUp();
  console.log(`Removed — ${await prisma.product.count({ where: { model: { startsWith: P } } })} test model(s) left.`);
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll receiving checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Inventory step 1 — the catalogue and counting — against a real database.
 *
 * The situations it will meet on the floor, run rather than reasoned about:
 *
 *   - the master loaded, loaded again, edited and loaded again
 *   - a cost already set is never changed by the master; a missing one is filled
 *   - a model missing from a later master is not deleted
 *   - a first count, a recount, a blank box, a zero, a count that matched
 *   - a watch on the shelf that is not on the list: added, flagged, later
 *     given its details by the master
 *   - the count sheet downloaded, filled in, uploaded
 *   - a count sheet with a typo, or a model on two rows: nothing saved
 *   - two people saving the same model at the same moment
 *   - stock history cannot be deleted by deleting the model
 *   - a totals row, a typo, or a number Excel mangled on the Count tab: refused,
 *     never made into a model that can never be removed
 *   - a renamed column, a formula with no value: refused, not skipped
 *   - the same sheet uploaded twice; an old sheet after a newer count
 *   - the real master, as rows, fits what the site accepts
 *
 * Every model it makes starts ZZTEST- and is removed at the end. Optional, with
 * the real files: STREAMOPS_MASTER_FILE (Invicta's master .xlsx) and
 * STREAMOPS_COUNT_SHEET (the opening count sheet) are read and checked too.
 * Refuses to run against anything but a local database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-inventory.mts
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { isMasterColumn, isMasterHeading, sheetRows } from "../src/lib/domain/inventory-sheets";
import { countSheet, getModel, importMaster, listStock, picturesFor, readCountSheet, readPhoto, removePhoto, saveCount, savePhoto, setImageUrl } from "../src/lib/server/inventory";
import { MAX_PHOTO_BYTES } from "../src/lib/domain/watch-images";

assertDevDatabase("check-inventory.mts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const P = "ZZTEST-";

async function cleanUp() {
  const ids = (await prisma.product.findMany({ where: { model: { startsWith: P } }, select: { id: true } })).map((p) => p.id);
  // Only a test may remove stock history, and only its own.
  await prisma.stockMove.deleteMany({ where: { productId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Product", entityId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
}

/** A master file like Invicta's: a title row, headings on row 2. */
async function masterFile(rows: Record<string, unknown>[], extraSheet?: Record<string, unknown>[]) {
  const wb = new ExcelJS.Workbook();
  const headings = [
    "Invicta Model", "Small Main Image", "Brand", "PF Code", "Collection", "Series", "Gender", "Description", "URL",
    "", "Package weight(lb)", "Package length(inch)", "Package width(inch)", "Package height(inch)", "",
    "eBay Shipping Profile Name", "", "Cost", "TP",
  ];
  const add = (name: string, list: Record<string, unknown>[]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(["Tiktok", "", "", "", "eBay", 104986]);
    ws.addRow(headings);
    for (const r of list) ws.addRow(headings.map((h) => (h ? (r[h] ?? null) : null)) as ExcelJS.CellValue[]);
  };
  add("Inventory", rows);
  if (extraSheet) add("Random Pulls Show", extraSheet);
  // Through a real file and back, exactly as the browser reads it.
  const read = new ExcelJS.Workbook();
  await read.xlsx.load((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  return sheetRows(read, isMasterHeading, isMasterColumn);
}

const product = (model: string) => prisma.product.findUniqueOrThrow({ where: { model } });
const stock = async (model: string) => (await getModel(model))!.balances;

const boss = await prisma.user.findFirst({ where: { role: "BOSS", isActive: true }, select: { id: true } });
if (!boss) {
  console.log("SKIP  needs an admin account. Run the seed first.");
  await prisma.$disconnect();
  process.exit(0);
}

try {
  await cleanUp();

  /* ------------------------------------------------------------ the master */

  console.log("The master file.");
  const first = await importMaster(
    boss.id,
    "master.xlsx",
    await masterFile(
      [
        { "Invicta Model": `${P}49888`, Brand: "Invicta", Collection: "Speedway", Description: "Speedway 51mm", Cost: 35, TP: 53.85, "Package weight(lb)": 1, "Package length(inch)": 6, "Package width(inch)": 6, "Package height(inch)": 6, "eBay Shipping Profile Name": "eBay Live Shipping Policy Small" },
        { "Invicta Model": `${P}TM-525003`, Brand: "Technomarine", Description: "Carbon Nautic", Cost: 0 },
        { "Invicta Model": "", Description: "a blank row" },
      ],
      [
        { "Invicta Model": `${P}28684`, Description: "Only on the random pulls sheet", Cost: 12 },
        { "Invicta Model": `${P}30018`, Cost: 9 },
      ],
    ),
  );
  check("loads every model, from every sheet", [first.ok, first.added], [true, 4]);
  check("reads its details", (await product(`${P}49888`)).ebayShippingProfile, "eBay Live Shipping Policy Small");
  check("its cost", (await product(`${P}49888`)).costCents, 3500);
  check("a cost of 0 in the master is no cost", (await product(`${P}TM-525003`)).costCents, null);

  const again = await importMaster(boss.id, "master.xlsx", await masterFile([
    { "Invicta Model": `${P}49888`, Brand: "Invicta", Collection: "Speedway", Description: "Speedway 51mm", Cost: 35, TP: 53.85, "Package weight(lb)": 1, "Package length(inch)": 6, "Package width(inch)": 6, "Package height(inch)": 6, "eBay Shipping Profile Name": "eBay Live Shipping Policy Small" },
  ]));
  check("the same file again changes nothing", [again.added, again.updated], [0, 0]);

  const edited = await importMaster(boss.id, "master-2.xlsx", await masterFile([
    { "Invicta Model": `${P}49888`, Description: "Speedway 51mm, steel", Cost: 40 },
    { "Invicta Model": `${P}TM-525003`, Cost: 150 },
  ]));
  check("an edited description is taken", (await product(`${P}49888`)).description, "Speedway 51mm, steel");
  check("a cost already set is never changed by the master", (await product(`${P}49888`)).costCents, 3500);
  check("a missing cost is filled", (await product(`${P}TM-525003`)).costCents, 15000);
  check("and the screen says so", edited.costsFilled, 1);
  check("a model left out of the new file is not deleted", (await prisma.product.count({ where: { model: `${P}28684` } })), 1);

  const notMaster = await importMaster(boss.id, "wrong.xlsx", await (async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Sheet1").addRow(["Order ID", "Buyer"]);
    const read = new ExcelJS.Workbook();
    await read.xlsx.load((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    return sheetRows(read, isMasterHeading, isMasterColumn);
  })());
  check("a file that is not the master is refused", notMaster.ok, false);
  const withTotals = await importMaster(boss.id, "totals.xlsx", await masterFile([
    { "Invicta Model": `${P}49888`, Description: "Speedway 51mm" },
    { "Invicta Model": "Total", Description: "", Cost: 99999 },
  ]));
  check("a totals row in the master is skipped and named, never made a model", [withTotals.skipped.length, await prisma.product.count({ where: { model: "TOTAL" } })], [1, 0]);
  check("a model with no description is flagged", (await product(`${P}30018`)).needsDetails, true);
  check("one with a description is not", (await product(`${P}49888`)).needsDetails, false);

  /* ------------------------------------------------------------- counting */

  console.log("\nCounting.");
  const m = `${P}49888`;
  await saveCount(boss.id, [{ model: m, counted: { SELLABLE: 24, SAMPLE_EBAY: 1, SAMPLE_TIKTOK: 1 } }], "test");
  check("a first count sets the stock", await stock(m), { SELLABLE: 24, SAMPLE_EBAY: 1, SAMPLE_TIKTOK: 1, RANDOM_PULLS: 0, DAMAGED: 0 });

  await saveCount(boss.id, [{ model: m, counted: { SELLABLE: 21 } }], "test");
  check("a recount moves it to what was counted", (await stock(m)).SELLABLE, 21);
  check("and leaves the places not counted alone", (await stock(m)).SAMPLE_EBAY, 1);

  await saveCount(boss.id, [{ model: m, counted: { DAMAGED: 0, SAMPLE_EBAY: 1 } }], "test");
  const lines = await prisma.stockMove.findMany({
    where: { product: { model: m } },
    orderBy: { at: "desc" },
    take: 2,
    select: { place: true, qty: true, countedQty: true },
  });
  check(
    "a count that matched still leaves a line, so the history shows it was counted",
    lines.map((l) => [l.place, l.qty, l.countedQty]).sort(),
    [["DAMAGED", 0, 0], ["SAMPLE_EBAY", 0, 1]],
  );
  const spot = `${P}TM-525003`;
  await saveCount(boss.id, [{ model: spot, counted: { DAMAGED: 0 } }], "spot check");
  const spotRow = (await listStock(spot)).find((r) => r.model === spot)!;
  check("a spot check of one place is a count, but not a full count", [spotRow.lastCountedAt !== null, spotRow.fullyCountedAt], [true, null]);
  await saveCount(boss.id, [{ model: spot, counted: { SELLABLE: 0, SAMPLE_EBAY: 0, SAMPLE_TIKTOK: 0, RANDOM_PULLS: 0 } }], "rest");
  check("once all five places are counted it is", (await listStock(spot)).find((r) => r.model === spot)!.fullyCountedAt !== null, true);
  check("a blank count saves nothing", (await saveCount(boss.id, [{ model: m, counted: {} }], "test")).ok, false);

  /* ------------------------------------------------ not on the list */

  console.log("\nA watch that is not on the list.");
  const stray = `${P}50133`;
  const refusedNew = await saveCount(boss.id, [{ model: stray, counted: { SELLABLE: 12 } }], "test");
  check("an unknown model is refused unless it is added on purpose", refusedNew.ok, false);
  check("and nothing is created", await prisma.product.count({ where: { model: stray } }), 0);
  const added = await saveCount(boss.id, [{ model: stray, counted: { SELLABLE: 12 }, description: "Pro Diver 44mm", allowNew: true }], "test");
  check("it is added and counted", [added.added, (await stock(stray)).SELLABLE], [[stray], 12]);
  check("and flagged for its details", (await product(stray)).needsDetails, true);
  await importMaster(boss.id, "master-3.xlsx", await masterFile([{ "Invicta Model": stray, Description: "Pro Diver Men 44mm", Cost: 41 }]));
  check("the master later gives it its details and clears the flag", [(await product(stray)).needsDetails, (await product(stray)).costCents], [false, 4100]);
  check("its count is untouched", (await stock(stray)).SELLABLE, 12);

  /* --------------------------------------------------- the count sheet */

  console.log("\nThe count sheet.");
  const sheet = new ExcelJS.Workbook();
  await sheet.xlsx.load(await countSheet());
  const ws = sheet.getWorksheet("Count")!;
  check("the downloaded sheet has the headings", (ws.getRow(2).values as unknown[]).slice(1, 9), [
    "Model", "Description", "Collection", "Sellable", "Sample eBay", "Sample TikTok", "Random pulls", "Damaged",
  ]);
  let filledRow = 0;
  ws.eachRow((row, n) => {
    if (row.getCell(1).value === `${P}TM-525003`) {
      row.getCell(4).value = 5; // Sellable
      row.getCell(8).value = 2; // Damaged
      filledRow = n;
    }
  });
  check("the catalogue's models are on it", filledRow > 2, true);
  sheet.getWorksheet("Models not on the list")!.addRow([`${P}99001`, "Bolt 52mm", 3]);
  const filled = (await sheet.xlsx.writeBuffer()) as ArrayBuffer;
  const read = await readCountSheet(filled);
  check("reads back only the rows with numbers", read.entries.map((e) => e.model).sort(), [`${P}99001`, `${P}TM-525003`]);
  check("with no problems", read.problems, []);
  const saved = await saveCount(boss.id, read.entries, "test sheet");
  check("and saves them", [(await stock(`${P}TM-525003`)).SELLABLE, (await stock(`${P}TM-525003`)).DAMAGED], [5, 2]);
  check("adding the one not on the list", saved.added, [`${P}99001`]);

  // A typo and a model on two rows: nothing saved, every problem named.
  ws.eachRow((row) => {
    if (row.getCell(1).value === `${P}TM-525003`) row.getCell(4).value = "five";
    if (row.getCell(1).value === `${P}49888`) row.getCell(5).value = 2;
  });
  sheet.getWorksheet("Models not on the list")!.addRow([`${P}49888`, "again", 1]);
  const bad = await readCountSheet((await sheet.xlsx.writeBuffer()) as ArrayBuffer);
  check("a typo is named", bad.problems.some((p) => p.includes(`${P}TM-525003`) && p.includes("five")), true);
  check("a model on two rows is named", bad.problems.some((p) => p.includes("counted twice")), true);

  console.log("\nWhat Excel and tired fingers do to a count sheet.");
  const fresh = async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await countSheet("2021-01-01"));
    return wb;
  };
  const upload = async (wb: ExcelJS.Workbook) => {
    const r = await readCountSheet((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    if (r.problems.length > 0) return { ok: false, problems: r.problems };
    return saveCount(boss.id, r.entries, "test sheet");
  };
  const before = await prisma.product.count();

  for (const [what, model] of [["a totals row", "Total"], ["a typo", `${P}4988`], ["a number Excel changed", "4.9888E+4"]] as const) {
    const wb = await fresh();
    wb.getWorksheet("Count")!.addRow([model, "", "", 5]);
    const r = await upload(wb);
    check(`${what} on the Count tab is refused`, r.ok, false);
    check(`and nothing is created for it`, await prisma.product.count(), before);
  }
  {
    const wb = await fresh();
    wb.getWorksheet("Models not on the list")!.addRow(["4.9888E+4", "mangled", 1]);
    const r = await upload(wb);
    check("even on the not-on-the-list tab, a mangled number is refused", r.ok, false);
  }
  {
    const wb = await fresh();
    wb.getWorksheet("Count")!.getCell("D2").value = "Sellable qty";
    const r = await upload(wb);
    check("a renamed column is refused, not skipped", r.ok === false && r.problems.some((x) => x.includes('"Sellable"')), true);
  }
  {
    const wb = await fresh();
    const ws2 = wb.getWorksheet("Count")!;
    ws2.eachRow((row) => {
      if (row.getCell(1).value === `${P}TM-525003`) row.getCell(4).value = { formula: "B1+1" } as ExcelJS.CellFormulaValue;
    });
    const r = await upload(wb);
    check("a formula with no saved value is refused, not read as blank", r.ok, false);
  }
  {
    const wb = await fresh();
    wb.getWorksheet("Count")!.eachRow((row) => {
      if (row.getCell(1).value === `${P}TM-525003`) row.getCell(4).value = { formula: "1/0", result: { error: "#DIV/0!" } } as ExcelJS.CellFormulaValue;
    });
    const r = await upload(wb);
    check("an Excel error in a cell is refused and named as Excel shows it", r.ok === false && r.problems.some((x) => x.includes("#DIV/0!")), true);
  }
  {
    const wb = await fresh();
    wb.getWorksheet("Count")!.eachRow((row) => {
      if (row.getCell(1).value === `${P}TM-525003`) row.getCell(4).value = 6;
    });
    const once = await upload(wb);
    const twice = await upload(wb);
    check("the same sheet uploaded twice: the second changes nothing", [once.ok, "changed" in twice ? twice.changed : -1], [true, 0]);
    // A recount on the screen, then the old sheet uploaded again: the old
    // numbers come back. Expected — a count is what is there — and why the
    // sheet is dated and says to download a fresh one each time.
    await saveCount(boss.id, [{ model: `${P}TM-525003`, counted: { SELLABLE: 4 } }], "test");
    await upload(wb);
    check("an old sheet after a newer count puts its own numbers back (as warned on the sheet)", (await stock(`${P}TM-525003`)).SELLABLE, 6);
    check("the sheet says when it was downloaded", String(wb.getWorksheet("Count")!.getCell("A1").value).startsWith("Downloaded 2021-01-01"), true);
  }

  /* ------------------------------------------- two people at once */

  console.log("\nTwo people counting the same model at once.");
  const both = await Promise.all([
    saveCount(boss.id, [{ model: `${P}28684`, counted: { RANDOM_PULLS: 7 } }], "a"),
    saveCount(boss.id, [{ model: `${P}28684`, counted: { RANDOM_PULLS: 7 } }], "b"),
  ]);
  check("both are saved", both.map((r) => r.ok), [true, true]);
  check("and the stock is what they counted, not double", (await stock(`${P}28684`)).RANDOM_PULLS, 7);

  /* ------------------------------------------------------- pictures */

  console.log("\nPictures: an uploaded photo, the master's link, and a link typed in.");
  const pic = `${P}PIC1`;
  const link1 = "https://trade.invictawatch.com/cdn/media/202309/448200_46307.jpg";
  const link2 = "https://cdn.invictawatch.com/products/main/500x500-p/202601/49888.jpg";
  await importMaster(boss.id, "pictures.xlsx", await masterFile([{ "Invicta Model": pic, Description: "Picture test", URL: link1 }]));
  const pictureOf = async (model: string) => (await listStock(model)).find((r) => r.model === model)?.picture;
  check("a new model shows the master's link", await pictureOf(pic), link1);

  const jpeg = (n: number, fill = 7) => { const b = new Uint8Array(n).fill(fill); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
  check("a photo is saved", await savePhoto(boss.id, pic, jpeg(40_000)), { ok: true });
  const withPhoto = await pictureOf(pic);
  check("then the photo is shown instead of the link", withPhoto?.startsWith(`/api/inventory/photo/${pic}?v=`), true);
  check("and the photo can be read back whole", (await readPhoto(pic))?.data.length, 40_000);

  await new Promise((res) => setTimeout(res, 5));
  check("a second photo replaces the first", await savePhoto(boss.id, pic, jpeg(30_000, 9)), { ok: true });
  check("  one photo per model, the new one", [await prisma.productPhoto.count({ where: { product: { model: pic } } }), (await readPhoto(pic))?.data[10]], [1, 9]);
  check("  at a new address, so nobody sees the old one from their browser's memory", (await pictureOf(pic)) !== withPhoto, true);

  await importMaster(boss.id, "pictures-again.xlsx", await masterFile([{ "Invicta Model": pic, Description: "Picture test", URL: link2 }]));
  check("a new master changes the link but leaves the photo showing", [(await product(pic)).imageUrl, (await pictureOf(pic))?.startsWith("/api/")], [link2, true]);

  check("a web page dressed as a photo is refused", (await savePhoto(boss.id, pic, new TextEncoder().encode("<html>"))).ok, false);
  check("an empty file is refused", (await savePhoto(boss.id, pic, new Uint8Array())).ok, false);
  check("a photo over the limit is refused", (await savePhoto(boss.id, pic, jpeg(MAX_PHOTO_BYTES + 1))).ok, false);
  check("  and the photo already there is untouched", (await readPhoto(pic))?.data.length, 30_000);
  check("a photo for a model that is not in the catalogue is refused", (await savePhoto(boss.id, `${P}NOPE`, jpeg(100))).ok, false);
  check("a model typed in lower case with spaces finds its photo", (await readPhoto(` ${pic.toLowerCase()} `))?.data.length, 30_000);

  const [a, b] = await Promise.all([savePhoto(boss.id, pic, jpeg(1000, 1)), savePhoto(boss.id, pic, jpeg(2000, 2))]);
  check("two people uploading at once: both are answered, and one photo is kept", [a.ok, b.ok, await prisma.productPhoto.count({ where: { product: { model: pic } } })], [true, true, 1]);

  check("removing the photo goes back to the link", [(await removePhoto(boss.id, pic)).ok, await pictureOf(pic)], [true, link2]);
  check("removing it twice is harmless", (await removePhoto(boss.id, pic)).ok, true);

  check("a typed link that is not a web address is refused", (await setImageUrl(boss.id, pic, "#N/A")).ok, false);
  check("  as is the app's own photo address", (await setImageUrl(boss.id, pic, "/api/inventory/photo/X")).ok, false);
  check("  and the link is unchanged", (await product(pic)).imageUrl, link2);
  check("a typed link is saved, trimmed", [(await setImageUrl(boss.id, pic, `  ${link1} `)).ok, (await product(pic)).imageUrl], [true, link1]);
  check("a blank clears it, and the model shows no picture", [(await setImageUrl(boss.id, pic, "  ")).ok, await pictureOf(pic)], [true, ""]);
  const logged = await prisma.auditLog.findMany({
    where: { entityId: (await product(pic)).id, action: { in: ["PHOTO_SAVED", "PHOTO_REMOVED", "IMAGE_URL_SET"] } },
    select: { action: true },
  });
  check("every change of picture is in the audit log (4 photos, 1 removal, 2 links)", logged.map((l) => l.action).sort(), [
    "IMAGE_URL_SET", "IMAGE_URL_SET", "PHOTO_REMOVED", "PHOTO_SAVED", "PHOTO_SAVED", "PHOTO_SAVED", "PHOTO_SAVED",
  ]);

  console.log("\nPictures on other screens (sales insights, the box log), by stock number.");
  const pic2 = `${P}PIC2`;
  await importMaster(boss.id, "pictures-3.xlsx", await masterFile([{ "Invicta Model": pic2, Description: "Picture test 2", URL: link1 }]));
  await savePhoto(boss.id, pic, jpeg(500));
  const messy = ` ${pic2.toLowerCase()} `;
  const looked = await picturesFor([pic2, messy, pic, "#300 - Invicta Random Pulls", "", pic2]);
  check("a model shows its link, however the report wrote its stock number", [looked.get(pic2), looked.get(messy)], [link1, link1]);
  check("a model with a photo shows the photo", looked.get(pic)?.startsWith("/api/inventory/photo/"), true);
  check("a placeholder listing or a blank gets no picture, not an error", [looked.get("#300 - Invicta Random Pulls"), looked.get("")], ["", ""]);
  check("nothing to look up is fine", (await picturesFor([])).size, 0);

  /* --------------------------------------- history cannot be deleted */

  let refused = false;
  try {
    await prisma.product.delete({ where: { model: m } });
  } catch {
    refused = true;
  }
  check("a model with stock history cannot be deleted", refused, true);

  /* ------------------------------------------------ the real files */

  const masterPath = process.env.STREAMOPS_MASTER_FILE;
  if (masterPath && existsSync(masterPath)) {
    console.log("\nThe real master file (read only — nothing is saved from it here).");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(masterPath));
    const models = new Set<string>();
    for (const sh of wb.worksheets) {
      sh.eachRow((row, n) => {
        if (n > 2 && row.getCell(1).value !== null) models.add(String((row.getCell(1).value as { result?: unknown })?.result ?? row.getCell(1).value).trim().toUpperCase());
      });
    }
    check("every sheet's models are seen (727 on Inventory + 19 elsewhere)", models.size >= 746, true);
    const rows = sheetRows(wb, isMasterHeading, isMasterColumn);
    const kb = Math.round(JSON.stringify(rows).length / 1024);
    console.log(`      (as rows it is ${kb} KB, from a ${Math.round(readFileSync(masterPath).length / 1024 / 1024)} MB file)`);
    check("as rows it fits well under what the site accepts (4.5 MB)", kb < 3000, true);
  } else {
    console.log("\nSKIP  real master: set STREAMOPS_MASTER_FILE.");
  }
  const countPath = process.env.STREAMOPS_COUNT_SHEET;
  if (countPath && existsSync(countPath)) {
    const real = await readCountSheet(readFileSync(countPath).buffer as ArrayBuffer);
    check("the opening count sheet already made is read without problems", real.problems, []);
  } else {
    console.log("SKIP  real count sheet: set STREAMOPS_COUNT_SHEET.");
  }
} finally {
  console.log("\nCleaning up.");
  await cleanUp();
  console.log(`Removed — ${await prisma.product.count({ where: { model: { startsWith: P } } })} test model(s) left.`);
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll inventory checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * The "missing from the master" list against a real database (Samuel, 21
 * October: the list to send Daniel).
 *
 *   - a model with a description, a cost and a picture is not on it
 *   - each missing piece is named: description, cost, picture
 *   - an uploaded photo counts as a picture
 *   - models in stock come first
 *   - the Excel download opens, with the model numbers as text
 *
 * Models are numbered 99003xx. It refuses to run against anything but a local
 * database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-master-gaps.mts
 */
import "dotenv/config";
import ExcelJS from "exceljs";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { masterGaps, masterGapsSheet, saveCount } from "../src/lib/server/inventory";

assertDevDatabase("check-master-gaps");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const M = (n: number) => `99003${String(n).padStart(2, "0")}`;
const MODELS = [1, 2, 3, 4, 5, 6].map(M);
async function clear() {
  const ids = (await prisma.product.findMany({ where: { model: { in: MODELS } }, select: { id: true } })).map((p) => p.id);
  if (ids.length > 0) {
    const entries = (await prisma.stockMove.findMany({ where: { productId: { in: ids } }, select: { entryId: true } })).map((m) => m.entryId);
    await prisma.stockMove.deleteMany({ where: { productId: { in: ids } } });
    await prisma.stockEntry.deleteMany({ where: { id: { in: entries } } });
    await prisma.productPhoto.deleteMany({ where: { productId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ids, ...entries] } } });
    await prisma.product.deleteMany({ where: { id: { in: ids } } });
  }
}
await clear();

const boss = await prisma.user.findFirst({ where: { role: "BOSS" }, select: { id: true } });
if (!boss) {
  console.log("SKIP  need an admin account. Run the seed first.");
  process.exit(0);
}

const link = "https://cdn.invictawatch.com/x.png";
await prisma.product.createMany({
  data: [
    { model: M(1), description: "Complete", costCents: 2_000, imageUrl: link },
    { model: M(2), description: "", costCents: 2_000, imageUrl: link },
    { model: M(3), description: "No cost", costCents: null, imageUrl: link },
    { model: M(4), description: "Photo only", costCents: 2_000, imageUrl: "" },
    { model: M(5), description: "", costCents: null, imageUrl: "" },
    // An undone typo: switched off, so not one to ask Invicta about.
    { model: M(6), description: "", costCents: null, imageUrl: "", active: false },
  ],
});
const p4 = await prisma.product.findUniqueOrThrow({ where: { model: M(4) }, select: { id: true } });
await prisma.productPhoto.create({ data: { productId: p4.id, data: Buffer.from([1, 2, 3]), contentType: "image/png" } });
// M(5) is in stock; the others are not.
check("counted in", (await saveCount(boss.id, [{ model: M(5), counted: { SELLABLE: 4 } }], "check-master-gaps")).ok);

const gaps = (await masterGaps()).filter((g) => MODELS.includes(g.model));
const of = (m: string) => gaps.find((g) => g.model === m);
check("a complete model is not on the list", !of(M(1)));
check("a missing description is named", JSON.stringify(of(M(2))?.missing) === '["Description"]');
check("a missing cost is named", JSON.stringify(of(M(3))?.missing) === '["Cost"]');
check("an uploaded photo counts as a picture", !of(M(4)));
check("everything missing is named", JSON.stringify(of(M(5))?.missing) === '["Description","Cost","Picture"]');
check("a switched-off model (an undone typo) is not on the list", !of(M(6)));
check("models in stock come first", gaps[0]?.model === M(5) && gaps[0]?.pieces === 4, JSON.stringify(gaps[0]));

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(await masterGapsSheet());
const ws = wb.worksheets[0];
const rows: string[] = [];
ws.eachRow((row, r) => {
  if (r > 2) rows.push(String(row.getCell(1).value));
});
check("the Excel download has the list", MODELS.filter((m) => m !== M(1) && m !== M(4) && m !== M(6)).every((m) => rows.includes(m)));
check("model numbers are kept as text", ws.getColumn(1).numFmt === "@");

await clear();
console.log(`\n${failures === 0 ? "All passed." : `${failures} failed.`} Fixtures removed.`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);

/**
 * Cost is for admins only (Samuel, 21 October) — against a real database.
 *
 *   - who may see cost: an admin yes; the shipping director, a packer, a streamer no
 *   - the product details sheet downloaded by the director has no costs in it
 *   - the same sheet for an admin has them
 *   - the director types a cost on a model page or in the sheet: ignored, the
 *     rest of what they typed is saved
 *   - an admin typing a cost for a model with none still fills it
 *
 * Every model is numbered 99002xx. It refuses to run against anything but a
 * local database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-cost-visibility.mts
 */
import "dotenv/config";
import ExcelJS from "exceljs";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { canSeeCost } from "../src/lib/auth/cost";
import { detailsSheet, saveDetails } from "../src/lib/server/product-details";

assertDevDatabase("check-cost-visibility");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const A = "9900201";
const B = "9900202";
async function clear() {
  const ids = (await prisma.product.findMany({ where: { model: { in: [A, B] } }, select: { id: true } })).map((p) => p.id);
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityType: "Product", entityId: { in: ids } } });
    await prisma.product.deleteMany({ where: { id: { in: ids } } });
  }
}
await clear();

const boss = await prisma.user.findFirst({ where: { role: "BOSS" }, select: { id: true } });
if (!boss) {
  console.log("SKIP  need an admin account. Run the seed first.");
  process.exit(0);
}

check("an admin may see cost", canSeeCost({ role: "BOSS" }));
check("the shipping director may not", !canSeeCost({ role: "MANAGER" }));
check("a packer or a streamer may not", !canSeeCost({ role: "EMPLOYEE" }));

await prisma.product.create({ data: { model: A, description: "Has a cost", costCents: 4200 } });
await prisma.product.create({ data: { model: B, description: "No cost yet" } });

async function costsInSheet(withCost: boolean): Promise<Map<string, unknown>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await detailsSheet({ withCost }));
  const ws = wb.worksheets[0];
  const head: string[] = [];
  ws.getRow(2).eachCell((c, i) => { head[i] = String(c.value); });
  const costCol = head.indexOf("Cost");
  const out = new Map<string, unknown>();
  ws.eachRow((row, r) => {
    if (r > 2) out.set(String(row.getCell(1).value), row.getCell(costCol).value);
  });
  return out;
}
const directorSheet = await costsInSheet(false);
check(
  "the director's details sheet has no cost in it, for any model",
  [...directorSheet.values()].every((v) => v === null || v === undefined || v === ""),
  `${A}: ${directorSheet.get(A)}`,
);
const adminSheet = await costsInSheet(true);
check("the admin's details sheet has the cost", adminSheet.get(A) === 42, `${adminSheet.get(A)}`);

const typed = await saveDetails(boss.id, [{ model: A, values: { Cost: 1, Description: "Typed by the director" } }], "check", { allowCost: false });
const a = await prisma.product.findUniqueOrThrow({ where: { model: A }, select: { costCents: true, description: true } });
check("the director types a cost on a model with one: ignored", typed.ok && a.costCents === 4200, `${a.costCents}`);
check("and the rest of what they typed is saved", a.description === "Typed by the director", a.description);

await saveDetails(boss.id, [{ model: B, values: { Cost: 9 } }], "check", { allowCost: false });
check(
  "the director types a cost on a model with none: still ignored",
  (await prisma.product.findUniqueOrThrow({ where: { model: B }, select: { costCents: true } })).costCents === null,
);

await saveDetails(boss.id, [{ model: B, values: { Cost: 9 } }], "check", { allowCost: true });
check(
  "an admin typing a cost for a model with none fills it",
  (await prisma.product.findUniqueOrThrow({ where: { model: B }, select: { costCents: true } })).costCents === 900,
);

await clear();
console.log(`\n${failures === 0 ? "All passed." : `${failures} failed.`} Fixtures removed.`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);

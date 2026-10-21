/**
 * The master's cost against a real database (Samuel, 21 October: the newest
 * master's cost is the cost, and every upload is kept as a history).
 *
 *   - a first master adds models with their costs, and is recorded
 *   - a later master says $10 where it was $8: the cost becomes $10, listed old and new
 *   - a blank or $0 cost in a later master never wipes a cost
 *   - a cost somebody typed in the app is still replaced by the master
 *   - a description somebody typed in the app is kept
 *   - a sale made before the change keeps the cost it sold at
 *   - the same file uploaded twice: the second changes nothing
 *   - two masters uploaded at the same moment: one after the other, both recorded
 *   - the history lists every upload, newest first
 *
 * Every model is numbered 99001xx and named after this script. It refuses to
 * run against anything but a local database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-master-cost.mts
 */
import "dotenv/config";
import { assertDevDatabase } from "./dev-only.mjs";
import { prisma } from "../src/lib/db";
import { toDbDate } from "../src/lib/domain/dates";
import type { SheetRows } from "../src/lib/domain/inventory-sheets";
import { importMaster, masterUploadLog } from "../src/lib/server/inventory";

assertDevDatabase("check-master-cost");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const FIXTURE = "check-master-cost";
const M = (n: number) => `99001${String(n).padStart(2, "0")}`;
const MODELS = [1, 2, 3, 4].map(M);

async function clearFixtures() {
  const ids = (await prisma.product.findMany({ where: { model: { in: MODELS } }, select: { id: true } })).map((p) => p.id);
  if (ids.length > 0) {
    await prisma.stockSale.deleteMany({ where: { productId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { entityType: "Product", entityId: { in: ids } } });
    await prisma.product.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.auditLog.deleteMany({ where: { action: "MASTER_LOADED", summary: { contains: FIXTURE } } });
}
await clearFixtures();

const boss = await prisma.user.findFirst({ where: { role: "BOSS" }, select: { id: true } });
if (!boss) {
  console.log("SKIP  need an admin account. Run the seed first.");
  process.exit(0);
}

const sheet = (rows: [string, number | string | null, string?][]): SheetRows => [
  {
    sheet: "Inventory",
    rows: rows.map(([model, cost, description], i) => ({
      line: i + 3,
      values: {
        "Invicta Model": model,
        Description: description ?? `Watch ${model}`,
        URL: `https://cdn.invictawatch.com/products/${model}.png`,
        Cost: cost,
      },
    })),
  },
];
const cost = async (model: string) =>
  (await prisma.product.findUnique({ where: { model }, select: { costCents: true } }))?.costCents ?? null;

/* ------------------------------------------------------------------ checks */

const first = await importMaster(boss.id, `${FIXTURE} first.xlsx`, sheet([[M(1), 8], [M(2), 20], [M(3), 15], [M(4), 30]]));
check("a first master adds its models with their costs", first.ok && first.added === 4 && (await cost(M(1))) === 800, JSON.stringify(first));

// A sale of model 1 at $8, before any change.
const p1 = await prisma.product.findUniqueOrThrow({ where: { model: M(1) }, select: { id: true } });
await prisma.stockSale.create({
  data: {
    key: `${FIXTURE}|1`, platform: "TIKTOK", orderRef: FIXTURE, showDate: toDbDate("2031-01-01"), show: "TikTok PM",
    listing: M(1), productId: p1.id, place: "SELLABLE", costCents: 800,
  },
});

// Somebody typed a cost and a description for model 3 in the app.
await prisma.product.update({
  where: { model: M(3) },
  data: { costCents: 1700, description: "Typed by the team", typedFields: ["costCents", "description"] },
});

const second = await importMaster(
  boss.id,
  `${FIXTURE} second.xlsx`,
  sheet([[M(1), 10], [M(2), null], [M(3), 16, "From the master"], [M(4), 0]]),
);
check("a later master saying $10 where it was $8: the cost becomes $10", (await cost(M(1))) === 1000);
check("a blank cost in the master never wipes a cost", (await cost(M(2))) === 2000);
check("a $0 cost in the master never wipes a cost", (await cost(M(4))) === 3000);
check("a cost typed in the app is still replaced by the master", (await cost(M(3))) === 1600);
const p3 = await prisma.product.findUniqueOrThrow({ where: { model: M(3) }, select: { description: true } });
check("a description typed in the app is kept", p3.description === "Typed by the team", p3.description);
const sale = await prisma.stockSale.findUniqueOrThrow({ where: { key: `${FIXTURE}|1` }, select: { costCents: true } });
check("a sale made before the change keeps the cost it sold at", sale.costCents === 800, `${sale.costCents}`);
check("the upload reports 2 costs changed", second.ok && second.costsChanged === 2, JSON.stringify(second));

const again = await importMaster(
  boss.id,
  `${FIXTURE} second again.xlsx`,
  sheet([[M(1), 10], [M(2), null], [M(3), 16, "From the master"], [M(4), 0]]),
);
check("the same file uploaded twice: the second changes no cost", again.ok && again.costsChanged === 0 && again.costsFilled === 0);

const [a, b] = await Promise.all([
  importMaster(boss.id, `${FIXTURE} race A.xlsx`, sheet([[M(1), 11]])),
  importMaster(boss.id, `${FIXTURE} race B.xlsx`, sheet([[M(1), 12]])),
]);
const after = await cost(M(1));
check(
  "two masters at the same moment: both succeed, the cost is one of theirs",
  a.ok && b.ok && (after === 1100 || after === 1200),
  `${after}`,
);

const log = (await masterUploadLog(200)).filter((u) => u.record?.fileName.startsWith(FIXTURE));
check("the history has all 5 uploads", log.length === 5, `${log.length}`);
check(
  "newest first",
  log.every((u, i) => i === 0 || log[i - 1].at.getTime() >= u.at.getTime()),
);
const secondEntry = log.find((u) => u.record?.fileName === `${FIXTURE} second.xlsx`)!;
check(
  "the second upload's record lists each cost change, old and new",
  // The database keeps the fields in its own order, so compare them as text.
  (secondEntry.record?.costsChanged ?? []).map((c) => `${c.model} ${c.from}→${c.to}`).join(", ") ===
    `${M(1)} 800→1000, ${M(3)} 1700→1600`,
  JSON.stringify(secondEntry.record?.costsChanged),
);
const firstEntry = log.find((u) => u.record?.fileName === `${FIXTURE} first.xlsx`)!;
check("the first upload's record lists the models it added", firstEntry.record?.added.length === 4);

await clearFixtures();
console.log(`\n${failures === 0 ? "All passed." : `${failures} failed.`} Fixtures removed.`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);

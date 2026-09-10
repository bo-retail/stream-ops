/** Temporary: re-imports the fixture day's exports. */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/db";
import { runImport } from "../src/lib/server/imports";

const dir = process.env.STREAMOPS_IMPORT_FIXTURES!;
const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith(".csv"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

const boss = await prisma.user.findFirst({ where: { role: "BOSS", isActive: true } });
if (!boss) throw new Error("No boss account found.");

const result = await runImport(files, boss.id);
console.log(`status: ${result.status ?? "(none)"}  batches: ${result.batchIds?.length ?? "?"}`);

const rows = await prisma.salesRecord.count({
  where: { showDate: new Date("2026-09-08T00:00:00.000Z") },
});
console.log(`${rows} sales rows on 2026-09-08.`);
await prisma.$disconnect();

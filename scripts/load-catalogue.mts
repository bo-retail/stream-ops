/**
 * Loads the catalogue at launch: Invicta's master file, then the offers, then
 * the shipping lists — exactly as if each had been uploaded on the website,
 * through the same code.
 *
 * Each file is recognised by its headings, not its name: the master has an
 * "Invicta Model" column, an offer a "Dani" column, a shipping list an "SOP"
 * column. Anything else is refused. Safe to run twice: the master adds and
 * updates and never deletes, an offer of the same date replaces itself, a
 * shipping list of the same SOP replaces itself.
 *
 * Without --confirm it only reads the files and says what it would load. With
 * --confirm it loads them into whatever DATABASE_URL points at — the live site
 * at launch, run from Samuel's own PowerShell right after `npm.cmd run db:deploy`.
 *
 *   npx.cmd tsx scripts/load-catalogue.mts "<master.xlsx>" "<offer.xlsx>" "<shipping list.xlsx>"
 *   npx.cmd tsx scripts/load-catalogue.mts --confirm "<master.xlsx>" ...
 *
 * (Run with NODE_OPTIONS=--conditions=react-server, as every script here is.)
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "../src/lib/db";
import { todayISO } from "../src/lib/domain/dates";
import { isMasterColumn, isMasterHeading, sheetRows } from "../src/lib/domain/inventory-sheets";
import type { SheetRows } from "../src/lib/domain/inventory-sheets";
import { isOfferColumn, isOfferHeading, isShippingListHeading, offerDateFromName } from "../src/lib/domain/receiving";
import { importMaster } from "../src/lib/server/inventory";
import { importOffer, importShippingList } from "../src/lib/server/receiving";
import { getSettings } from "../src/lib/server/settings";

const confirm = process.argv.includes("--confirm");
const paths = process.argv.slice(2).filter((a) => a !== "--confirm");

let host = "(unknown)";
try {
  host = new URL(process.env.DATABASE_URL ?? "").hostname;
} catch {
  // Shown as unknown; prisma reports the real problem if there is one.
}

if (paths.length === 0) {
  console.log('Name the files to load, in quotes. Example:\n  npx.cmd tsx scripts/load-catalogue.mts "C:\\Users\\samue\\Downloads\\Invicta Master Products 09.23.26.xlsx"');
  process.exit(1);
}

type Kind = "master" | "offer" | "shipping list";
interface Loaded {
  path: string;
  name: string;
  kind: Kind;
  sheets: SheetRows;
  rows: number;
}

/** What a file is, from its headings. The same readers the website uses. */
async function read(path: string): Promise<Loaded | string> {
  const name = basename(path);
  if (!existsSync(path)) return `${path}: not found — check the path (in quotes, with the full name).`;
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(readFileSync(path));
  } catch {
    return `${name}: could not be opened as an .xlsx file.`;
  }
  // An offer also has an "Invicta Model" column; its "Dani" column is what makes
  // it an offer, so a file with one is never read as the master.
  const offer = sheetRows(wb, isOfferHeading, isOfferColumn);
  const tries: [Kind, SheetRows][] = [
    ["master", offer.length > 0 ? [] : sheetRows(wb, isMasterHeading, isMasterColumn)],
    ["offer", offer],
    ["shipping list", sheetRows(wb, isShippingListHeading)],
  ];
  const found = tries.filter(([, s]) => s.length > 0);
  if (found.length !== 1) {
    return found.length === 0
      ? `${name}: not a master ("Invicta Model"), an offer ("Dani") or a shipping list ("SOP").`
      : `${name}: looks like more than one kind of file (${found.map(([k]) => k).join(", ")}).`;
  }
  const [kind, sheets] = found[0];
  return { path, name, kind, sheets, rows: sheets.reduce((n, s) => n + s.rows.length, 0) };
}

console.log(`\nDatabase: ${host}${confirm ? "" : "   (reading only — add --confirm to load)"}\n`);

const files: Loaded[] = [];
const refused: string[] = [];
for (const p of paths) {
  const r = await read(p);
  if (typeof r === "string") refused.push(r);
  else files.push(r);
}
for (const r of refused) console.log(`REFUSED  ${r}`);
if (refused.length > 0) {
  console.log("\nNothing was loaded. Fix the list of files and run it again.");
  await prisma.$disconnect();
  process.exit(1);
}

// The master first (it makes the models), then offers, then shipping lists.
const order: Kind[] = ["master", "offer", "shipping list"];
files.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

// The first touch of the database: if it cannot be reached, say so plainly.
let today;
try {
  today = todayISO((await getSettings()).timezone);
} catch (error) {
  void error;
  console.log(`Could not reach the database (${host}).\nNothing was loaded. Check the connection string and run it again.`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
}
for (const f of files) {
  const date = f.kind === "offer" ? offerDateFromName(f.name, today) : null;
  if (f.kind === "offer" && !date) {
    console.log(`REFUSED  ${f.name}: its date cannot be read from the name. Rename it to start with the date, e.g. "09.19 BO retail offer.xlsx".`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(`${confirm ? "LOADING " : "WOULD LOAD"}  ${f.kind.padEnd(13)} ${f.name}  (${f.rows} rows${date ? `, offer of ${date}` : ""})`);
}
if (!confirm) {
  console.log("\nThat is all it would do. Add --confirm to load them.");
  await prisma.$disconnect();
  process.exit(0);
}

const boss = await prisma.user.findFirst({ where: { role: "BOSS", isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
if (!boss) {
  console.log("\nNo active admin account to record this under. Nothing was loaded.");
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`\nRecorded as loaded by ${boss.name}.\n`);
let failed = false;
/** The useful line of an error: not the code excerpt Prisma prints around it. */
function reason(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const lines = error.message.split("\n").map((l) => l.trim());
  const useful = lines.filter((l) => l && !l.startsWith("→") && !/^\d+\s/.test(l) && !l.startsWith("Invalid `"));
  return useful.at(-1) ?? lines.find(Boolean) ?? "unknown error";
}

/** One file's load. A thrown error (the connection dropped, a timeout) is said plainly, not as a stack trace. */
async function load(f: Loaded): Promise<boolean> {
  try {
    return await loadOne(f);
  } catch (error) {
    const why = reason(error);
    console.log(`FAILED   ${f.name}: ${why}`);
    console.log("         Nothing from this file was saved.");
    return false;
  }
}

async function loadOne(f: Loaded): Promise<boolean> {
  if (f.kind === "master") {
    const r = await importMaster(boss!.id, f.name, f.sheets);
    if (!r.ok) {
      console.log(`FAILED   ${f.name}: ${r.problems.join(" ")}`);
      return false;
    }
    console.log(`OK       master: ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged; ${r.flagged} need their details; ${r.costsFilled} cost(s) filled.`);
    if (r.skipped.length > 0) console.log(`         skipped ${r.skipped.length} row(s) whose model number cannot be one: ${r.skipped.slice(0, 5).join("; ")}`);
  } else if (f.kind === "offer") {
    const date = offerDateFromName(f.name, today)!;
    const r = await importOffer(boss!.id, f.name, date, f.sheets);
    if (!r.ok) {
      console.log(`FAILED   ${f.name}: ${r.problems.slice(0, 10).join(" ")}`);
      return false;
    }
    console.log(`OK       offer of ${date}: ${r.lines} model(s), ${r.pieces} piece(s) ordered; ${r.created.length} new model(s) created${r.replaced ? " (replaced the earlier copy)" : ""}.`);
  } else {
    const r = await importShippingList(boss!.id, f.name, f.sheets);
    if (!r.ok) {
      console.log(`FAILED   ${f.name}: ${r.problems.slice(0, 10).join(" ")}`);
      return false;
    }
    for (const s of r.shipments) {
      console.log(`OK       shipment ${s.sop}: ${s.lines} model(s), ${s.pieces} piece(s)${s.replaced ? " (replaced)" : ""}. Not in stock until it is counted.`);
    }
  }
  return true;
}

for (const f of files) {
  if (!(await load(f))) failed = true;
}

console.log(`\nProducts in the catalogue now: ${await prisma.product.count()}.`);
await prisma.$disconnect();
console.log(
  failed
    ? "\nSome files did not load — see FAILED above. The ones marked OK did load. " +
        "Running it again is safe: what is already in is updated, never doubled."
    : "\nDone.",
);
process.exit(failed ? 1 : 0);

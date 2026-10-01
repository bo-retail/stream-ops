import "server-only";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { badModelNumber, normaliseModel, parseMoney, parseNumber } from "@/lib/domain/inventory";
import { sheetRows } from "@/lib/domain/inventory-sheets";
import type { Cell, SheetRows } from "@/lib/domain/inventory-sheets";
import { DETAILS_COLUMNS, isDetailsHeading } from "@/lib/domain/receiving";
import { storableLink } from "@/lib/domain/watch-images";

/**
 * The product details: everything about a model that the offer does not say.
 *
 * Typed on a model's page or uploaded on the product details sheet — both come
 * here, so they behave the same. What is filled in replaces what the model has
 * (the product details always win over the master and the offer); a blank
 * keeps it. Cost is the exception: this only fills a missing one, because a
 * cost already set came from a shipment and only a cost correction changes it.
 */

export interface DetailsEntry {
  model: string;
  /** The cells as given, by the sheet's column names. Blank or missing keeps what is there. */
  values: Partial<Record<(typeof DETAILS_COLUMNS)[number], Cell>>;
  where?: string;
}

type Change = {
  brand?: string; collection?: string; gender?: string; description?: string; ebayShippingProfile?: string; upc?: string;
  imageUrl?: string; costCents?: number; tpCents?: number; msrpCents?: number;
  weightLb?: number; lengthIn?: number; widthIn?: number; heightIn?: number;
};

const TEXT: [(typeof DETAILS_COLUMNS)[number], keyof Change][] = [
  ["Brand", "brand"], ["Collection", "collection"], ["Gender", "gender"], ["Description", "description"],
  ["eBay shipping profile", "ebayShippingProfile"],
];
const MONEY: [(typeof DETAILS_COLUMNS)[number], "tpCents" | "msrpCents"][] = [["TP", "tpCents"], ["MSRP", "msrpCents"]];
const SIZE: [(typeof DETAILS_COLUMNS)[number], "weightLb" | "lengthIn" | "widthIn" | "heightIn"][] = [
  ["Weight (lb)", "weightLb"], ["Length (in)", "lengthIn"], ["Width (in)", "widthIn"], ["Height (in)", "heightIn"],
];

const blank = (v: Cell | undefined) => v === null || v === undefined || String(v).trim() === "";

/** One row read into the changes it asks for, or why it cannot be. */
export function readDetails(e: DetailsEntry): { change: Change; problems: string[] } {
  const v = e.values;
  const change: Change = {};
  const problems: string[] = [];
  for (const [col, key] of TEXT) if (!blank(v[col])) (change as Record<string, string>)[key] = String(v[col]).trim().slice(0, 4000);
  for (const [col, key] of MONEY) {
    if (blank(v[col])) continue;
    const cents = parseMoney(v[col]);
    if (cents === null || cents === 0) problems.push(`${col}: "${v[col]}" is not a price.`);
    else change[key] = cents;
  }
  for (const [col, key] of SIZE) {
    if (blank(v[col])) continue;
    const n = parseNumber(v[col]);
    if (n === null || n === 0) problems.push(`${col}: "${v[col]}" is not a size.`);
    else change[key] = n;
  }
  if (!blank(v.Cost)) {
    const cents = parseMoney(v.Cost);
    if (cents === null || cents === 0) problems.push(`Cost: "${v.Cost}" is not a price.`);
    else change.costCents = cents;
  }
  if (!blank(v.UPC)) {
    // A barcode typed into Excel as a number comes back as 7.6E+11: refused, not guessed.
    const upc = typeof v.UPC === "number" ? (Number.isInteger(v.UPC) && v.UPC < 1e15 ? String(v.UPC) : "") : String(v.UPC).trim();
    if (!/^\d{8,14}$/.test(upc)) problems.push(`UPC: "${v.UPC}" is not a barcode (8 to 14 digits). In Excel, format the column as text.`);
    else change.upc = upc;
  }
  if (!blank(v["Image URL"])) {
    const link = storableLink(String(v["Image URL"]));
    if (link === "") problems.push(`Image URL: "${v["Image URL"]}" is not a web address.`);
    else change.imageUrl = link;
  }
  return { change, problems };
}

export interface DetailsResult {
  ok: boolean;
  updated: string[];
  unchanged: number;
  /** Cost given for a model that already has one: left alone. */
  costKept: string[];
  problems: string[];
}

/** Save product details for one model or many. All or nothing. */
export async function saveDetails(userId: string, entries: DetailsEntry[], source: string): Promise<DetailsResult> {
  const fail = (problems: string[]): DetailsResult => ({ ok: false, updated: [], unchanged: 0, costKept: [], problems });
  const problems: string[] = [];
  const read: { model: string; change: Change }[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const model = normaliseModel(e.model);
    const at = e.where ? `${e.where}${model ? ` (${model})` : ""}: ` : model ? `${model}: ` : "";
    const bad = badModelNumber(model);
    if (bad) {
      problems.push(`${at}${bad}.`);
      continue;
    }
    if (seen.has(model)) {
      problems.push(`${at}appears twice. Keep one row.`);
      continue;
    }
    seen.add(model);
    const r = readDetails(e);
    problems.push(...r.problems.map((p) => `${at}${p}`));
    read.push({ model, change: r.change });
  }
  if (problems.length > 0) return fail(problems);

  const products = new Map(
    (await prisma.product.findMany({ where: { model: { in: read.map((r) => r.model) } } })).map((p) => [p.model, p]),
  );
  const missing = read.filter((r) => !products.has(r.model)).map((r) => r.model);
  if (missing.length > 0) {
    return fail([`Not in the catalogue: ${missing.join(", ")}. A model comes in from an offer, a shipping list or a count first.`]);
  }

  return prisma.$transaction(async (tx) => {
    const updated: string[] = [];
    const costKept: string[] = [];
    let unchanged = 0;
    for (const { model, change } of read) {
      const p = products.get(model)!;
      const data: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      for (const [k, value] of Object.entries(change)) {
        if (k === "costCents") {
          if (p.costCents === null) data.costCents = value;
          else if (p.costCents !== value) costKept.push(model);
          continue;
        }
        if ((p as Record<string, unknown>)[k] !== value) {
          data[k] = value;
          before[k] = (p as Record<string, unknown>)[k];
        }
      }
      const description = (data.description as string | undefined) ?? p.description;
      if (p.needsDetails !== (description === "")) data.needsDetails = description === "";
      if (Object.keys(data).length === 0) {
        unchanged++;
        continue;
      }
      await tx.product.update({ where: { id: p.id }, data });
      await tx.auditLog.create({
        data: {
          entityType: "Product",
          entityId: p.id,
          action: "DETAILS_SAVED",
          actorId: userId,
          summary: `Product details of ${model} (${source}): ${Object.keys(data).filter((k) => k !== "needsDetails").join(", ") || "flag cleared"}.`,
          before: before as object,
          after: data as object,
        },
      });
      updated.push(model);
    }
    return { ok: true, updated, unchanged, costKept, problems: [] };
  });
}

/* ---------------------------------------------------------------- the sheet */

/**
 * The product details sheet: the models that still need their details first
 * (created from an offer or a shipping list, or added at a count), then every
 * other model, each with what it has now. Change what is wrong, fill what is
 * blank, upload it.
 */
export async function detailsSheet(): Promise<ArrayBuffer> {
  const products = await prisma.product.findMany({ orderBy: [{ needsDetails: "desc" }, { active: "asc" }, { model: "asc" }] });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Product details", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.getCell("A1").value =
    "Fill in or correct, then upload. A blank cell keeps what the model has. Cost only fills a missing cost. " +
    "Models still needing their details are at the top.";
  ws.getCell("A1").font = { italic: true, color: { argb: "FF5B6472" } };
  ws.getRow(2).values = [...DETAILS_COLUMNS];
  ws.getRow(2).font = { bold: true };
  ws.columns = [14, 14, 18, 10, 44, 10, 10, 10, 11, 11, 11, 11, 24, 16, 40].map((width) => ({ width }));
  const money = (c: number | null) => (c === null ? null : c / 100);
  for (const p of products) {
    ws.addRow([
      p.model, p.brand, p.collection, p.gender, p.description, money(p.costCents), money(p.tpCents), money(p.msrpCents),
      p.weightLb, p.lengthIn, p.widthIn, p.heightIn, p.ebayShippingProfile, p.upc, p.imageUrl,
    ]);
  }
  // Model numbers and barcodes as text, so Excel never turns them into something else.
  ws.getColumn(1).numFmt = "@";
  ws.getColumn(14).numFmt = "@";
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** A filled-in product details sheet. Rows with only a model number change nothing. */
export async function readDetailsSheet(buffer: ArrayBuffer): Promise<{ entries: DetailsEntry[]; problems: string[] }> {
  let sheets: SheetRows;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    sheets = sheetRows(wb, isDetailsHeading);
  } catch {
    return { entries: [], problems: ["That is not an Excel (.xlsx) file. Download the product details sheet and fill that in."] };
  }
  if (sheets.length === 0) return { entries: [], problems: ['No sheet has a "Model" column. Is this the product details sheet?'] };
  const entries: DetailsEntry[] = [];
  for (const { sheet, rows } of sheets) {
    for (const { line, values } of rows) {
      const pick: DetailsEntry["values"] = {};
      for (const col of DETAILS_COLUMNS) {
        const k = Object.keys(values).find((h) => h.trim().toLowerCase() === col.toLowerCase());
        if (k !== undefined) pick[col] = values[k];
      }
      if (blank(pick.Model)) continue;
      entries.push({ model: String(pick.Model), values: pick, where: `${sheet}, row ${line}` });
    }
  }
  return { entries, problems: [] };
}

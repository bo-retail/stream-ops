import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import real from "./fixtures/listing-rows.json";
import { LISTING_FILES, ebayRows, tiktokRows, toCells, type ListingKind, type PlanProduct } from "./show-plan";
import { appendRows, columnLetter, fillSheet, stripRows } from "./xlsx-rows";

/**
 * The upload files against the team's own: the templates' headings, a filled
 * file read back by a spreadsheet library, and the app's rows cell for cell
 * against real rows from the files they upload today.
 */

const template = (kind: ListingKind) =>
  readFile(path.join(import.meta.dirname, "..", "server", "listing-templates", LISTING_FILES[kind].file));

const text = (v: ExcelJS.CellValue): string | number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "richText" in v) return v.richText.map((r) => r.text).join("");
  if (typeof v === "object" && "result" in v) return (v.result as string | number) ?? null;
  return v as string | number;
};

async function read(bytes: Uint8Array | Buffer, sheet: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return { wb, ws: wb.getWorksheet(sheet)! };
}

const rowValues = (ws: ExcelJS.Worksheet, r: number, n: number) =>
  Array.from({ length: n }, (_, i) => text(ws.getRow(r).getCell(i + 1).value));

describe("the blank templates", () => {
  for (const kind of ["ebay", "tiktok"] as const) {
    it(`${kind}: the headings are the ones the rows are keyed by, and no listing rows are left`, async () => {
      const t = LISTING_FILES[kind];
      const { ws } = await read(await template(kind), t.sheetName);
      expect(rowValues(ws, t.headingRow, t.columns.length)).toEqual([...t.columns]);
      expect(ws.actualRowCount).toBeLessThanOrEqual(t.headerRows);
    });
  }

  it("keeps every sheet TikTok's importer reads, hidden ones included", async () => {
    const { wb } = await read(await template("tiktok"), "Template");
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(["Template", "TemplateConfig", "Category", "Brand"]));
    expect(text(wb.getWorksheet("TemplateConfig")!.getCell("B2").value)).toBe("create_product");
  });
});

describe("the app's rows against the team's real files", () => {
  // The products as the real rows describe them.
  const ebayProduct: PlanProduct = {
    model: "33271",
    description: "INVICTA Pro Diver Men 42mm Stainless Steel Gold Black dial PC32 Quartz",
    imageUrl: "https://trade.invictawatch.com/cdn/media/202009/309566_33271-catalogshot-2020.jpg",
    costCents: 1_000, tpCents: 5_000, msrpCents: null, weightLb: 0.8, lengthIn: 6, widthIn: 6, heightIn: 6,
    ebayShippingProfile: "eBay Live Shipping Policy Small",
  };
  const asText = (row: (string | number | null)[]) => row.map((v) => (v === null || v === "" ? null : String(v)));

  it("eBay: a $1 watch on the 09.08 PM show is the team's row 5, every one of the 85 cells", () => {
    const rows = ebayRows(
      [{ model: "33271", AM: 0, PM: 1, setPrice: false, tiktok: 0 }],
      new Map([["33271", ebayProduct]]),
      "2026-09-08",
      "PM",
    );
    expect(asText(toCells(rows[0], LISTING_FILES.ebay.columns))).toEqual(asText(real.ebay));
  });

  it("TikTok: two real rows, every one of the 37 cells", () => {
    const products: PlanProduct[] = real.tiktok.map((r) => ({
      model: String(r[2]), description: String(r[3]), imageUrl: String(r[4]),
      costCents: 1_000, tpCents: 5_000, msrpCents: null,
      weightLb: Number(r[5]), lengthIn: Number(r[6]), widthIn: Number(r[7]), heightIn: Number(r[8]),
      ebayShippingProfile: "",
    }));
    const rows = tiktokRows(
      products.map((p) => ({ model: p.model, AM: 0, PM: 0, setPrice: false, tiktok: 1 })),
      new Map(products.map((p) => [p.model, p])),
    );
    // Sorted by model: "51283" before "TM-525003".
    expect(asText(toCells(rows[1], LISTING_FILES.tiktok.columns))).toEqual(asText(real.tiktok[0]));
    expect(asText(toCells(rows[0], LISTING_FILES.tiktok.columns))).toEqual(asText(real.tiktok[1]));
  });
});

describe("filling a template", () => {
  it("writes the rows straight after the headings and leaves the headings as they were", async () => {
    for (const kind of ["ebay", "tiktok"] as const) {
      const t = LISTING_FILES[kind];
      const blank = await template(kind);
      const filled = await fillSheet(blank, t.sheet, [["ROW-1", 2.5, null, "a & b < c"], ["ROW-2"]]);
      const before = await read(blank, t.sheetName);
      const after = await read(filled, t.sheetName);
      for (let r = 1; r <= t.headerRows; r++) {
        expect(rowValues(after.ws, r, t.columns.length)).toEqual(rowValues(before.ws, r, t.columns.length));
      }
      expect(rowValues(after.ws, t.headerRows + 1, 4)).toEqual(["ROW-1", 2.5, null, "a & b < c"]);
      expect(text(after.ws.getCell(`A${t.headerRows + 2}`).value)).toBe("ROW-2");
      expect(after.wb.worksheets.map((w) => w.name)).toEqual(before.wb.worksheets.map((w) => w.name));
    }
  });

  it("changes nothing in the file but the one sheet", async () => {
    const blank = await template("tiktok");
    const filled = await fillSheet(blank, LISTING_FILES.tiktok.sheet, [["X"]]);
    const [a, b] = await Promise.all([JSZip.loadAsync(blank), JSZip.loadAsync(filled)]);
    expect(Object.keys(b.files).sort()).toEqual(Object.keys(a.files).sort());
    for (const name of Object.keys(a.files)) {
      if (name === LISTING_FILES.tiktok.sheet || a.files[name].dir) continue;
      expect(await b.file(name)!.async("base64"), name).toBe(await a.file(name)!.async("base64"));
    }
  });
});

describe("sheet XML", () => {
  it("names columns as Excel does", () => {
    expect([0, 25, 26, 51, 52, 84].map(columnLetter)).toEqual(["A", "Z", "AA", "AZ", "BA", "CG"]);
  });

  const sheet = (rows: string) => `<worksheet><dimension ref="A1:C9"/><sheetData>${rows}</sheetData></worksheet>`;

  it("strips the listing rows, self-closing ones too, and shrinks the dimension", () => {
    const xml = sheet('<row r="1"><c r="A1"><v>1</v></c></row><row r="2" s="3"/><row r="3"><c r="A3"><v>3</v></c></row><row r="9" spans="1:3"/>');
    expect(stripRows(xml, 2)).toBe(sheet('<row r="1"><c r="A1"><v>1</v></c></row><row r="2" s="3"/>').replace("A1:C9", "A1:C2"));
  });

  it("escapes text, drops characters XML cannot hold, keeps leading spaces, and skips blanks", () => {
    const out = appendRows(sheet('<row r="1"/>'), [["<b>&\u0001", 3, null, " x"]]);
    expect(out).toContain('<row r="2"><c r="A2" t="inlineStr"><is><t>&lt;b&gt;&amp;</t></is></c><c r="B2"><v>3</v></c><c r="D2" t="inlineStr"><is><t xml:space="preserve"> x</t></is></c></row>');
    expect(out).toContain('<dimension ref="A1:C2"/>');
  });

  it("fills a sheet that has no rows at all", () => {
    expect(appendRows("<worksheet><sheetData/></worksheet>", [["A"]])).toBe(
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>A</t></is></c></row></sheetData></worksheet>',
    );
  });
});

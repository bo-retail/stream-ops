/**
 * Reading a spreadsheet's rows by their headings.
 *
 * Shared by the server (count sheets) and the browser (Invicta's master file,
 * which is 24 MB of embedded pictures — far over what the site accepts — so the
 * browser reads it and sends only the rows). One reader, so both read a file
 * the same way.
 */
import type ExcelJS from "exceljs";

/** A plain cell: text, a number, or nothing. */
export type Cell = string | number | null;
export type SheetRows = { sheet: string; rows: { line: number; values: Record<string, Cell> }[] }[];

/**
 * What a formula cell with no saved result reads as.
 *
 * Excel saves the result with the formula, so this is rare — but read as blank
 * it would quietly drop a number. As text it is refused like any other cell
 * that is not a count.
 */
export const NO_VALUE = "(a formula with no saved value)";

/** A cell as plain text or a number, whatever the spreadsheet wrapped it in. */
export function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("formula" in v || "sharedFormula" in v) {
      const result = (v as { result?: unknown }).result;
      if (result === undefined || result === null) return NO_VALUE;
      if (typeof result === "number" || typeof result === "string") return result;
      // #N/A, #DIV/0! and the like, as Excel shows them.
      if (typeof result === "object" && result !== null && "error" in result) return String((result as { error: unknown }).error);
      if (result instanceof Date) return result.toISOString().slice(0, 10);
      return String(result);
    }
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
    if ("text" in v) return String((v as { text: unknown }).text);
    if ("error" in v) return String((v as { error: unknown }).error);
  }
  return null;
}

/**
 * Every sheet's rows, keyed by the heading row found in its first six rows.
 *
 * The heading row is the first with a cell matching `isHeading`, because these
 * files carry a title or totals row above their headings. A sheet with no such
 * row is skipped. `keep`, when given, limits the columns kept to the headings
 * it accepts, so only what is needed travels.
 */
export function sheetRows(
  wb: ExcelJS.Workbook,
  isHeading: (cell: string) => boolean,
  keep?: (heading: string) => boolean,
): SheetRows {
  const out: SheetRows = [];
  for (const ws of wb.worksheets) {
    let headingRow = 0;
    let headings: string[] = [];
    for (let r = 1; r <= Math.min(6, ws.rowCount); r++) {
      const cells = (ws.getRow(r).values as ExcelJS.CellValue[]).slice(1).map((c) => String(cellValue(c) ?? "").trim());
      if (cells.some(isHeading)) {
        headingRow = r;
        headings = cells;
        break;
      }
    }
    if (headingRow === 0) continue;
    const rows: SheetRows[number]["rows"] = [];
    ws.eachRow((row, n) => {
      if (n <= headingRow) return;
      const cells = (row.values as ExcelJS.CellValue[]).slice(1);
      const values: Record<string, Cell> = {};
      headings.forEach((h, i) => {
        if (h && (!keep || keep(h))) values[h] = cellValue(cells[i]);
      });
      if (Object.values(values).some((v) => v !== null && v !== "")) rows.push({ line: n, values });
    });
    out.push({ sheet: ws.name, rows });
  }
  return out;
}

/** The master's heading row: the one with "Invicta Model". */
export const isMasterHeading = (cell: string) => /^invicta model$/i.test(cell.trim());

/** The headings the catalogue reads from the master. Everything else stays behind. */
const MASTER_COLUMNS = [
  "invicta model", "model", "brand", "collection", "series", "gender", "description", "url", "image url",
  "small main image", "cost", "tp", "msrp", "package weight(lb)", "weight (lb)", "package length(inch)",
  "length (in)", "package width(inch)", "width (in)", "package height(inch)", "height (in)",
  "ebay shipping profile name", "ebay shipping profile",
];
export const isMasterColumn = (heading: string) => MASTER_COLUMNS.includes(heading.trim().toLowerCase());

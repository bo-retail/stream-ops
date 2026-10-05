/**
 * Writing rows into a worksheet of somebody else's .xlsx without touching
 * anything else in it.
 *
 * eBay's and TikTok's upload templates carry hidden sheets, dropdowns and (on
 * TikTok) a TemplateConfig sheet their importers read. Opening and re-saving
 * them with a spreadsheet library risks losing some of that, so the listing
 * files are made by editing the one sheet's XML directly: the header rows the
 * platform put there stay byte for byte, and the day's rows go in after them.
 *
 * Pure: XML text in, XML text out. Unzipping and zipping is the caller's.
 */

export type XlsxCell = string | number | null | undefined;

/** "A", "B", … "Z", "AA", … for a 0-based column index. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const ROW = /<row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;

/** The sheet with every row after `keep` removed (the template's own listing rows). */
export function stripRows(sheetXml: string, keep: number): string {
  const stripped = sheetXml
    .replace(ROW, (row, r: string) => (Number(r) <= keep ? row : ""))
    // Opens at the top of the listings, not scrolled to where the old ones ended.
    .replace(/(<pane\b[^>]*?\btopLeftCell=")([A-Z]+)\d+"/, (_m, head: string, col: string) => `${head}${col}${keep + 1}"`)
    .replace(/(<selection\b[^>]*?\bpane="bottomLeft"[^>]*?)\bactiveCell="[A-Z]+\d+" sqref="[A-Z]+\d+"/, (_m, head: string) => `${head}activeCell="A${keep + 1}" sqref="A${keep + 1}"`);
  return stripped.replace(/<dimension ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"\s*\/>/, (_m, c1: string, r1: string, c2?: string) =>
    `<dimension ref="${c1}${r1}${c2 ? `:${c2}${keep}` : ""}"/>`,
  );
}

/** The number of the last row in the sheet, or 0 when it has none. */
export function lastRow(sheetXml: string): number {
  let last = 0;
  for (const m of sheetXml.matchAll(ROW)) last = Math.max(last, Number(m[1]));
  return last;
}

/**
 * Characters XML 1.0 cannot carry at all (control codes a pasted description
 * can bring with it). Excel refuses the whole file over one of them.
 */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function escapeXml(s: string): string {
  return s.replace(NOT_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cellXml(ref: string, value: XlsxCell): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : "";
  }
  const text = escapeXml(value);
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}" t="inlineStr"><is><t${space}>${text}</t></is></c>`;
}

/**
 * The sheet with `rows` added after its last row. Text goes in as inline
 * strings, numbers as numbers; blanks are left out, as Excel does.
 */
export function appendRows(sheetXml: string, rows: XlsxCell[][]): string {
  const start = lastRow(sheetXml) + 1;
  const xml = rows
    .map((cells, i) => {
      const r = start + i;
      return `<row r="${r}">${cells.map((v, c) => cellXml(`${columnLetter(c)}${r}`, v)).join("")}</row>`;
    })
    .join("");
  let out = sheetXml.includes("<sheetData/>")
    ? sheetXml.replace("<sheetData/>", `<sheetData>${xml}</sheetData>`)
    : sheetXml.replace("</sheetData>", `${xml}</sheetData>`);
  const end = start + rows.length - 1;
  if (rows.length > 0) {
    out = out.replace(/<dimension ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"\s*\/>/, (_m, c1: string, r1: string, c2?: string) =>
      `<dimension ref="${c1}${r1}:${c2 ?? c1}${end}"/>`,
    );
  }
  return out;
}

/**
 * A workbook's bytes with `rows` written after the last row of one sheet,
 * every other part of the file untouched.
 */
export async function fillSheet(workbook: Uint8Array | ArrayBuffer, sheetPath: string, rows: XlsxCell[][]): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(workbook);
  const sheet = zip.file(sheetPath);
  if (!sheet) throw new Error(`The workbook has no ${sheetPath}.`);
  zip.file(sheetPath, appendRows(await sheet.async("string"), rows));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

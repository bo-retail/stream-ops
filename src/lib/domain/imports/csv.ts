/**
 * A real CSV reader.
 *
 * Both marketplace exports break a naive line-splitting parser, in different
 * ways, so this is written to the actual shape of the files rather than to a
 * comfortable subset of CSV:
 *
 *   - TikTok's `Shipping Information` column holds a quoted cell with embedded
 *     newlines. One 156-record file is 781 physical lines. Splitting on "\n"
 *     produces garbage that still looks like data.
 *   - Both files are UTF-8 with a byte-order mark. Left in place, the first
 *     header reads as "﻿Order ID" and every lookup by name misses.
 *   - eBay quotes some headers and not others, in the same row.
 *
 * Deliberately not a dependency. The format needed here is small and fixed, and
 * a parser we can read is worth more than one we cannot when the exports change
 * shape — which they already have once.
 */

/** A blank line in the source: one empty field, nothing else. */
export function isBlankRow(row: readonly string[]): boolean {
  return row.length === 0 || row.every((cell) => cell.trim() === "");
}

/**
 * Splits CSV text into rows of raw fields.
 *
 * Quoted fields may contain commas, newlines and doubled quotes. Nothing is
 * trimmed and nothing is type-converted — callers decide that, because the
 * whitespace matters (TikTok pads IDs with tabs) and the types must not be
 * guessed (`1,022.25`, 19-digit ids).
 */
export function parseCsv(text: string): string[][] {
  // Strip the BOM before anything else looks at the first header.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = "";
    started = true;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (inQuotes) {
      if (ch === '"') {
        // "" inside a quoted field is a literal quote.
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      started = true;
      continue;
    }
    if (ch === ",") {
      endField();
      continue;
    }
    if (ch === "\r") {
      // Swallow the \n of a \r\n pair so it does not open an empty row.
      if (source[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    if (ch === "\n") {
      endRow();
      continue;
    }
    field += ch;
  }

  // A file ending in a newline must not produce a trailing phantom row, but a
  // genuinely empty last line (eBay puts one before its footer) must survive.
  if (field !== "" || row.length > 0 || started) endRow();

  return rows;
}

/**
 * Pairs a header row with the rows beneath it.
 *
 * Every value is trimmed here, which is also what removes the trailing tab
 * characters TikTok appends to `Order ID`, `Product ID`, `Package ID`, `Zipcode`
 * and every `* Time` column — and the leading space in the header
 * ` Virtual Bundle Seller SKU`. Untrimmed, an ID never matches across files.
 *
 * Short rows yield "" rather than undefined, so a caller never has to guard.
 */
export function toRecords(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): Record<string, string>[] {
  const keys = header.map((h) => h.trim());
  return rows.map((row) => {
    const record: Record<string, string> = {};
    for (let i = 0; i < keys.length; i++) {
      record[keys[i]] = (row[i] ?? "").trim();
    }
    return record;
  });
}

/**
 * A number a spreadsheet has rounded off: `9.43461E+21`.
 *
 * Excel holds fifteen significant digits. A tracking number has twenty-two and
 * an order id nineteen, so opening an export and saving it turns them into
 * this, and the original digits are gone — there is nothing to recover them
 * from. The cell still looks like data, which is the danger: on 09/18's eBay
 * report it left two distinct tracking numbers where there had been 135, and
 * the day's parcels would have been built as two enormous boxes carrying
 * labels that exist nowhere.
 */
const ROUNDED_OFF = /^-?\d(\.\d+)?E\+?\d{1,3}$/i;

/** A long all-digit id: the only kind of value the padded form can appear in. */
const LONG_DIGITS = /^\d{16,}$/;

/**
 * The same damage in its other form.
 *
 * Given a wide enough column, Excel writes the fifteen digits it kept and pads
 * the rest with zeros — `9434608106245500000000` — which still looks like a
 * tracking number and reads as one.
 *
 * On its own this says almost nothing: an 18-digit TikTok order id ending in
 * three zeros is perfectly ordinary, and one row in a thousand does. Tested
 * against 2,000 synthetic untouched TikTok days, treating this alone as damage
 * refused 23% of them — a day that cannot be imported however many times it is
 * downloaded again, which is worse than the thing being guarded against. It is
 * only evidence alongside `allPaddedTogether`.
 */
function isPaddedWithZeros(value: string): boolean {
  return LONG_DIGITS.test(value) && /^0+$/.test(value.slice(15));
}

/**
 * Whether a column's long numbers were padded *together*.
 *
 * A spreadsheet converts a whole column at once, so damage is never one row
 * among intact neighbours: either every long value in the column is padded, or
 * none of it is. That is what tells a converted column from an order id that
 * happens to end in zeros.
 */
function allPaddedTogether(values: readonly string[]): boolean {
  /*
    Distinct values, because the same one repeated is not corroboration.

    A sample show sells everything under one stand-in listing, so its Product ID
    and SKU ID are the same nineteen digits on all two hundred rows. If that one
    id happened to end in four zeros, every row would be "padded" and the day
    refused — on exactly the kind of upload this change exists to allow. Real
    damage leaves distinct values, because the fifteen digits that survived
    still differ from row to row.
  */
  const long = [...new Set(values)].filter((v) => LONG_DIGITS.test(v));
  return long.length >= 2 && long.every(isPaddedWithZeros);
}

/**
 * The columns a spreadsheet has damaged, with how many rows each lost.
 *
 * Reports are edited outside the app on purpose — a sample show's stock numbers
 * are typed in after the show — so this is not a reason to refuse editing. It
 * is what makes the difference between an edit that worked and one that quietly
 * destroyed the day visible at the moment of upload rather than at the packing
 * table.
 */
export interface RoundedOffColumn {
  column: string;
  rows: number;
  /** One of the ruined values, to show her what to look for in the file. */
  example: string;
}

/**
 * @param columns The columns that hold long numbers, and only those.
 *   Every other column is somebody's free text — a stock number, a listing
 *   title, a buyer's note — and a stock number reading "5E3" is not damage. The
 *   whole file is refused when this finds something, so a false positive costs
 *   a day that cannot be imported at all, however many times it is downloaded
 *   again.
 */
export function roundedOffColumns(
  records: readonly Record<string, string>[],
  columns: readonly string[],
): RoundedOffColumn[] {
  const found: RoundedOffColumn[] = [];
  for (const column of columns) {
    const values = records.map((r) => r[column] ?? "");

    // The `9.43E+21` form is unmistakable on its own: no id, tracking number
    // or record number is ever written that way, so one row is enough.
    const exponent = values.filter((v) => ROUNDED_OFF.test(v));
    // The padded form needs the rest of its column to agree. Both forms can
    // appear in one column — Excel writes one or the other depending on how
    // wide the column was — so the count is of everything lost, not of
    // whichever form was noticed first.
    const padded = allPaddedTogether(values) ? values.filter(isPaddedWithZeros) : [];

    if (exponent.length + padded.length > 0) {
      found.push({
        column,
        rows: exponent.length + padded.length,
        example: exponent[0] ?? padded[0],
      });
    }
  }
  return found.sort((a, b) => b.rows - a.rows);
}

/**
 * What to tell whoever uploaded it.
 *
 * Written for the person at the shipping desk: what is wrong, that it cannot be
 * salvaged from this copy, and the two ways to make the edit without it
 * happening again.
 */
export function roundedOffMessage(fileName: string, damaged: readonly RoundedOffColumn[]): string {
  const worst = damaged[0];
  const others =
    damaged.length > 1
      ? ` The same happened to ${damaged
          .slice(1)
          .map((d) => d.column)
          .join(", ")}.`
      : "";
  return (
    `${fileName}: this file has been opened and saved in a spreadsheet, and its long numbers have been ` +
    `rounded off — ${worst.column} reads "${worst.example}" on ${worst.rows} row(s) instead of the real ` +
    `number.${others} The real digits are not in this file any more, so nothing was imported. ` +
    `Download the report again, and if it needs editing, open it in Google Sheets (File, Import, and turn ` +
    `off "Convert text to numbers"), or in Excel use Data, From Text/CSV and set every column to Text.`
  );
}

/**
 * Compares a file's headers against what the code was written for.
 *
 * The whole point of the ingestion rules is that they depend on exact column
 * names. If a platform renames or reorders one, every rule downstream is
 * quietly wrong rather than loudly broken — so a mismatch stops the import
 * instead of producing numbers nobody should trust. Columns appended at the end
 * are the one tolerable change.
 */
export interface HeaderCheck {
  ok: boolean;
  /** Expected headers that are missing or in the wrong place. */
  problems: string[];
  /** Unknown headers appended after the expected ones. Tolerated. */
  extra: string[];
}

export function checkHeaders(
  actual: readonly string[],
  expected: readonly string[],
): HeaderCheck {
  const trimmed = actual.map((h) => h.trim());
  const problems: string[] = [];

  for (let i = 0; i < expected.length; i++) {
    if (trimmed[i] !== expected[i]) {
      problems.push(
        trimmed[i] === undefined
          ? `column ${i + 1}: expected "${expected[i]}", file ends`
          : `column ${i + 1}: expected "${expected[i]}", found "${trimmed[i]}"`,
      );
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    extra: trimmed.slice(expected.length),
  };
}

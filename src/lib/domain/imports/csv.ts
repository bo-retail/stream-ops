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

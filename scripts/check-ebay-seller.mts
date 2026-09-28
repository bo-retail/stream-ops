/**
 * Which business an eBay report is written under, when the day ran both.
 *
 * The schedule cannot choose on such a day, so before this the whole upload was
 * refused — on 09/27 the floor had a day's orders it could not load. The file
 * can choose: eBay names the seller account on its last line. What has to hold:
 *
 *   - a file naming a known account places itself, whatever the schedule says
 *   - a file naming an account nobody has registered is refused, by name
 *   - one known account in the upload must NOT place a second file that named
 *     an unknown one, which would write a diamond report under watches
 *
 * No database and no fixtures: the reports are built here, because what is
 * being tested is which name ends up on the rows.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-ebay-seller.mts
 */
import "dotenv/config";
import { readFiles } from "../src/lib/server/imports";
import { businessOfEbaySeller } from "../src/lib/domain/business";
import { ebayFallback } from "../src/lib/domain/imports/ebay-business";
import { readEbaySeller } from "../src/lib/domain/imports/ebay";
import { EBAY_HEADERS } from "../src/lib/domain/imports/types";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
  if (!ok) failures++;
}

/** An eBay export of one paid watch, from the named seller account. */
function report(seller: string, srn: string, stock: string): string {
  const row: Record<string, string> = {
    "Sales Record Number": srn,
    "Order Number": `18-15123-9044${srn}`,
    "Buyer Username": "test_buyer",
    "Ship To Name": "Test Buyer",
    "Item Number": "407197269275",
    "Item Title": stock,
    "Custom Label": "09.27.26 PM",
    Quantity: "1",
    "Sold For": "$25.00",
    "Total Price": "$25.00",
    "Sale Date": "Sep-27-26",
    "Paid On Date": "Sep-27-26",
    "Tracking Number": `94346081062455520153${srn}`,
    "Transaction ID": `1234567890123${srn}`,
  };
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return (
    "﻿" +
    [
      ",".repeat(41),
      EBAY_HEADERS.map((h) => `"${h}"`).join(","),
      EBAY_HEADERS.map(() => '""').join(","),
      EBAY_HEADERS.map((h) => cell(row[h] ?? "")).join(","),
      "",
      "1,record(s) downloaded,",
      `Seller ID : ${seller}`,
    ].join("\r\n")
  );
}

const watches = { name: "watch.csv", text: report("vaultshowofficial", "11", "50967") };
const unknown = { name: "unknown.csv", text: report("caratclubofficial", "22", "E95677") };

/* A day the schedule cannot answer for: both kinds of show ran eBay. */
const ambiguousDay = { kind: "ambiguous" as const, candidates: ["DIAMOND", "WATCH"] as ("DIAMOND" | "WATCH")[] };

/*
  The upload path resolves the schedule itself, so these call `readFiles` the
  way `runImport` does — with the answer the schedule gave, which on this day
  is nothing usable. "WATCH" is what `runImport` passes in that case.
*/
const known = readFiles([watches], "WATCH");
check("a known account places its own file", known.business, "WATCH");
check("and reads its sales", known.sales.length, 1);

const stranger = readFiles([unknown], "WATCH");
check(
  "a file with an unregistered account falls back to what it was given",
  stranger.business,
  "WATCH",
);

/*
  The case that matters, decided one level up: both files in one upload, one
  account known and one not. The known one must not answer for the other, or a
  diamond report is written under watches on the very day this exists to
  unblock. `runImport` asks `ebayFallback` exactly this question.
*/
const accountOf = (text: string) => {
  const id = readEbaySeller(text);
  return id ? businessOfEbaySeller(id) : null;
};
check("the known account is read", accountOf(watches.text), "WATCH");
check("the unregistered one is not guessed at", accountOf(unknown.text), null);
check(
  "so a day that ran both is refused rather than filed under the known one",
  ebayFallback([accountOf(watches.text), accountOf(unknown.text)], ambiguousDay).kind,
  "unplaceable",
);
check(
  "while a day that ran only watches places the unregistered file from the schedule",
  ebayFallback([accountOf(unknown.text)], { kind: "placed", business: "WATCH" }),
  { kind: "fallback", business: "WATCH" },
);

/* And the ordinary day is untouched: one file, one account, no schedule needed. */
const plain = readFiles([watches], "DIAMOND");
check("the file beats the answer it was given", plain.business, "WATCH");

console.log(`\nschedule on such a day: ${ambiguousDay.candidates.join(" and ")}`);
console.log(failures === 0 ? "All eBay seller checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

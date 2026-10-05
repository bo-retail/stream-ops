/**
 * Makes the blank eBay and TikTok upload templates the day's plan fills in.
 *
 * Run from the team's own working files ("Correct eBay Upload sheet.xlsx",
 * "Correct TT Upload Sheet.xlsx") whenever eBay or TikTok send a new template:
 *
 *   npx tsx scripts/make-listing-templates.mts "<eBay file>" "<TikTok file>"
 *
 * Everything in the file is kept byte for byte — the hidden sheets, the
 * dropdowns, TikTok's TemplateConfig sheet that its importer reads — except
 * the listing rows themselves, which are removed so the app can write the
 * day's. The calculation chain goes too: it only pointed at those rows, and
 * Excel rebuilds it. If a new template's headings differ, the template test
 * (listing-files.test.ts) fails and says which.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { LISTING_FILES } from "../src/lib/domain/show-plan";
import { stripRows } from "../src/lib/domain/xlsx-rows";

const [ebayPath, tiktokPath] = process.argv.slice(2);
if (!ebayPath || !tiktokPath) {
  console.error('Usage: npx tsx scripts/make-listing-templates.mts "<eBay file>" "<TikTok file>"');
  process.exit(1);
}

for (const [kind, from] of [["ebay", ebayPath], ["tiktok", tiktokPath]] as const) {
  const t = LISTING_FILES[kind];
  const zip = await JSZip.loadAsync(await readFile(from));
  const sheet = zip.file(t.sheet);
  if (!sheet) throw new Error(`${from} has no ${t.sheet} — is it the ${kind} template?`);
  zip.file(t.sheet, stripRows(await sheet.async("string"), t.headerRows));
  if (zip.file("xl/calcChain.xml")) {
    zip.remove("xl/calcChain.xml");
    const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
    zip.file("xl/_rels/workbook.xml.rels", rels.replace(/<Relationship [^>]*calcChain[^>]*\/>/g, ""));
    const types = await zip.file("[Content_Types].xml")!.async("string");
    zip.file("[Content_Types].xml", types.replace(/<Override [^>]*calcChain[^>]*\/>/g, ""));
  }
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const to = path.join("src", "lib", "server", "listing-templates", t.file);
  await writeFile(to, out);
  console.log(`${kind}: ${to} (${Math.round(out.length / 1024)} KB)`);
}

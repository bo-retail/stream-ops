import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LISTING_FILES, toCells, type FileRow, type ListingKind } from "@/lib/domain/show-plan";
import { fillSheet } from "@/lib/domain/xlsx-rows";

/**
 * Where the blank templates live. Made from the team's own working files by
 * `scripts/make-listing-templates.mts`; shipped with the app (see
 * `outputFileTracingIncludes` in next.config.ts).
 */
export function templatePath(kind: ListingKind): string {
  return path.join(process.cwd(), "src", "lib", "server", "listing-templates", LISTING_FILES[kind].file);
}

/**
 * The upload file: the platform's own template with the day's rows written in
 * after its headings, and nothing else in it changed.
 */
export async function listingFile(kind: ListingKind, rows: FileRow[]): Promise<Uint8Array> {
  const t = LISTING_FILES[kind];
  return fillSheet(await readFile(templatePath(kind)), t.sheet, rows.map((r) => toCells(r, t.columns)));
}

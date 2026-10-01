"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { isDateISO, todayISO } from "@/lib/domain/dates";
import { isSheetRows } from "@/lib/domain/inventory-sheets";
import type { SheetRows } from "@/lib/domain/inventory-sheets";
import { offerDateFromName, readLineCount } from "@/lib/domain/receiving";
import { readDetailsSheet, saveDetails } from "@/lib/server/product-details";
import type { DetailsEntry } from "@/lib/server/product-details";
import {
  finishShipmentCount,
  importOffer,
  importShippingList,
  readShipmentCountSheet,
  saveShipmentCount,
  settleDifference,
} from "@/lib/server/receiving";
import type { ShipmentCountEntry, ShipmentCountResult } from "@/lib/server/receiving";
import { getSettings } from "@/lib/server/settings";

/**
 * Receiving: who may do it is the same as for the rest of inventory — admins
 * and shipping directors (by role, never by name).
 */
const NOT_ALLOWED = "Only an admin or a shipping director can do that.";
const MAX_BYTES = 15 * 1024 * 1024;

export interface ReceivingState {
  error?: string;
  ok?: string;
  details?: string[];
}

async function director() {
  try {
    return await requireShippingDirectorOrThrow();
  } catch {
    return null;
  }
}

function refresh() {
  revalidatePath("/inventory", "layout");
}

const money = (c: number | null) => (c === null ? "no cost" : `$${(c / 100).toFixed(2)}`);

/* -------------------------------------------------------------------- offer */

/**
 * Daniel's offer, read in the browser (the real one is 5 MB of pictures) and
 * sent as rows. The date names it; the same date replaces.
 */
export async function uploadOfferRows(fileName: string, date: string, sheets: SheetRows): Promise<ReceivingState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  if (!isSheetRows(sheets)) return { error: "That file could not be read as an offer." };
  const day = date.trim() || offerDateFromName(fileName, todayISO((await getSettings()).timezone)) || "";
  if (!isDateISO(day)) return { error: "Which day is this offer? Pick its date." };
  const r = await importOffer(user.id, String(fileName).slice(0, 200), day, sheets);
  if (!r.ok) return { error: "Nothing was saved. Fix these in the file and upload it again:", details: r.problems.slice(0, 50) };
  refresh();
  return {
    ok: `${r.replaced ? "Replaced" : "Loaded"} the offer of ${day}: ${r.lines} model(s), ${r.pieces.toLocaleString("en-US")} piece(s) ordered.`,
    details:
      r.created.length > 0
        ? [`${r.created.length} new model(s) created, not active until they arrive and are counted. They need their product details: ${r.created.slice(0, 40).join(", ")}${r.created.length > 40 ? "…" : ""}`]
        : undefined,
  };
}

/* ------------------------------------------------------------ shipping list */

export async function uploadShippingListRows(fileName: string, sheets: SheetRows): Promise<ReceivingState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  if (!isSheetRows(sheets)) return { error: "That file could not be read as a shipping list." };
  const r = await importShippingList(user.id, String(fileName).slice(0, 200), sheets);
  if (!r.ok) return { error: "Nothing was saved:", details: r.problems.slice(0, 50) };
  refresh();
  return {
    ok: r.shipments
      .map((s) => `${s.replaced ? "Replaced" : "Loaded"} ${s.sop}: ${s.lines} model(s), ${s.pieces.toLocaleString("en-US")} piece(s).`)
      .join(" "),
    details: [
      "Nothing is in stock yet: it goes in when the shipment is counted.",
      ...(r.created.length > 0 ? [`Not in the catalogue before, created for counting: ${r.created.join(", ")}.`] : []),
    ],
  };
}

/* -------------------------------------------------------------- the count */

function countMessage(r: ShipmentCountResult): ReceivingState {
  const details: string[] = [];
  if (r.activated.length > 0) details.push(`Now active, ready for shows: ${r.activated.join(", ")}.`);
  if (r.notOnList.length > 0) details.push(`Not on the list, added as a difference with Invicta: ${r.notOnList.join(", ")}.`);
  for (const c of r.costChanges.slice(0, 20)) details.push(`${c.model}: cost ${money(c.before)} → ${money(c.after)}.`);
  return { ok: r.changed === 0 ? "Saved — nothing changed." : `Saved: ${r.changed} line(s) changed.`, details: details.length > 0 ? details : undefined };
}

/** What the page saw as already saved for a row, so a newer count by somebody else is never overwritten. */
type Before = { counted: number; damaged: number } | null;
const isBefore = (b: unknown): b is Before =>
  b === null ||
  (typeof b === "object" && Number.isInteger((b as { counted?: unknown }).counted) && Number.isInteger((b as { damaged?: unknown }).damaged));

/** The count typed on the shipment's page: one row per model, blanks skipped. */
export async function countShipment(
  sop: string,
  rows: { model: string; counted: string; damaged: string; before?: Before; allowNew?: boolean }[],
): Promise<ReceivingState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  if (!Array.isArray(rows) || rows.length > 2000) return { error: "That count could not be read." };
  const entries: ShipmentCountEntry[] = [];
  const problems: string[] = [];
  for (const row of rows) {
    const r = readLineCount(String(row?.counted ?? ""), String(row?.damaged ?? ""));
    if (r.ok === "blank") continue;
    if (r.ok === false) problems.push(`${row.model}: ${r.why}`);
    else {
      entries.push({
        model: String(row.model),
        ...r.count,
        before: row.before === undefined || !isBefore(row.before) ? undefined : row.before,
        allowNew: row.allowNew === true,
      });
    }
  }
  if (problems.length > 0) return { error: "Nothing was saved. Fix these:", details: problems };
  if (entries.length === 0) return { error: "Type at least one count. Leave a model blank only if it has not been counted yet." };
  const r = await saveShipmentCount(user.id, String(sop), entries, "shipment page");
  if (!r.ok) return { error: "Nothing was saved:", details: r.problems };
  refresh();
  return countMessage(r);
}

/** A filled-in shipment count sheet. */
export async function uploadShipmentCount(sop: string, _prev: ReceivingState, formData: FormData): Promise<ReceivingState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the file first." };
  if (file.size > MAX_BYTES) return { error: "That file is too big to be the right one." };
  const sheet = await readShipmentCountSheet(await file.arrayBuffer());
  if (sheet.problems.length > 0) return { error: "Nothing was saved. Fix these and upload it again:", details: sheet.problems.slice(0, 50) };
  if (sheet.sop && sheet.sop !== sop.toUpperCase()) {
    return { error: `That sheet is for ${sheet.sop}, not ${sop}. Upload it on ${sheet.sop}'s page.` };
  }
  if (sheet.entries.length === 0) return { error: "No counts were found. Is the Counted column filled in?" };
  const r = await saveShipmentCount(user.id, sop, sheet.entries, `count sheet ${file.name}`, { sheetDownloadedAt: sheet.downloadedAt });
  if (!r.ok) return { error: "Nothing was saved:", details: r.problems.slice(0, 50) };
  refresh();
  return countMessage(r);
}

/** Every model on the list not counted yet is counted as 0: short, for Invicta. */
export async function finishCount(sop: string): Promise<ReceivingState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  const r = await finishShipmentCount(user.id, String(sop));
  if (!r.ok) return { error: "Nothing was saved:", details: r.problems };
  refresh();
  return { ok: r.changed === 0 ? "Every model was already counted." : `Finished: ${r.changed} model(s) not counted are now short.` };
}

export async function settle(lineId: string, note: string): Promise<ReceivingState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  const r = await settleDifference(user.id, String(lineId), String(note ?? ""));
  if (!r.ok) return { error: r.problem };
  refresh();
  return { ok: "Settled." };
}

/* --------------------------------------------------------- product details */

/** One model's details, typed on its page. */
export async function saveModelDetails(model: string, values: DetailsEntry["values"]): Promise<ReceivingState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  if (!values || typeof values !== "object") return { error: "Those details could not be read." };
  const r = await saveDetails(user.id, [{ model: String(model), values }], "model page");
  if (!r.ok) return { error: "Not saved:", details: r.problems };
  refresh();
  return {
    ok: r.updated.length > 0 ? "Details saved." : "Nothing changed.",
    details: r.costKept.length > 0 ? ["The cost was not changed: it is already set, and only a cost correction changes it."] : undefined,
  };
}

/** The product details sheet, filled in. */
export async function uploadDetails(_prev: ReceivingState, formData: FormData): Promise<ReceivingState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the file first." };
  if (file.size > MAX_BYTES) return { error: "That file is too big to be the right one." };
  const sheet = await readDetailsSheet(await file.arrayBuffer());
  if (sheet.problems.length > 0) return { error: sheet.problems.join(" ") };
  if (sheet.entries.length === 0) return { error: "No rows with a model number were found." };
  const r = await saveDetails(user.id, sheet.entries, `product details sheet ${file.name}`);
  if (!r.ok) return { error: "Nothing was saved. Fix these and upload it again:", details: r.problems.slice(0, 50) };
  refresh();
  return {
    ok: `Saved: ${r.updated.length} model(s) changed, ${r.unchanged} unchanged.`,
    details: r.costKept.length > 0 ? [`Cost left as it was (already set; only a cost correction changes it): ${r.costKept.slice(0, 30).join(", ")}.`] : undefined,
  };
}

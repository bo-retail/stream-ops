"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { PLACES, PLACE_LABEL, normaliseModel, parseQty } from "@/lib/domain/inventory";
import type { CountedPlaces } from "@/lib/domain/inventory";
import type { SheetRows } from "@/lib/domain/inventory-sheets";
import { getModel, importMaster, readCountSheet, removePhoto, saveCount, savePhoto, setImageUrl } from "@/lib/server/inventory";
import type { Balances } from "@/lib/server/inventory";

/**
 * Who may change stock: admins and shipping directors. The same role that
 * uploads the day's reports, so there is nothing new to set up.
 */
const NOT_ALLOWED = "Only an admin or a shipping director can change stock.";

const MAX_BYTES = 15 * 1024 * 1024;

function refresh() {
  revalidatePath("/inventory");
}

/** The boxes typed for one model, read the same way as a cell in the count sheet. */
function readBoxes(values: Partial<Record<string, string>>): { counted: CountedPlaces; problems: string[] } {
  const counted: CountedPlaces = {};
  const problems: string[] = [];
  for (const place of PLACES) {
    const r = parseQty(values[place] ?? "");
    if (r.kind === "ok") counted[place] = r.qty;
    if (r.kind === "bad") problems.push(`${PLACE_LABEL[place]}: ${r.why}.`);
  }
  return { counted, problems };
}

export interface RowResult {
  error?: string;
  ok?: string;
  balances?: Balances;
}

/** One model's count, typed on the count screen. */
export async function countOne(model: string, values: Partial<Record<string, string>>, note = ""): Promise<RowResult> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: NOT_ALLOWED };
  }
  const { counted, problems } = readBoxes(values);
  if (problems.length > 0) return { error: problems.join(" ") };
  if (Object.keys(counted).length === 0) return { error: "Type at least one number. Leave a box blank only if you did not count that place." };

  const result = await saveCount(user.id, [{ model, counted, note }], "count screen");
  if (!result.ok) return { error: result.problems.join(" ") };
  const after = await getModel(model);
  refresh();
  return { ok: result.changed === 0 ? "Saved — it matched." : "Saved.", balances: after?.balances };
}

export interface FormState {
  error?: string;
  ok?: string;
  details?: string[];
  /** The model just added, so the page can offer to add its photo. */
  model?: string;
}

/** A watch on the shelf that is not on the list: added, flagged for its details, and counted. */
export async function addAndCount(_prev: FormState, formData: FormData): Promise<FormState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: NOT_ALLOWED };
  }
  const model = normaliseModel(formData.get("model"));
  const description = String(formData.get("description") ?? "").trim();
  if (model === "") return { error: "Type the model number from the watch." };
  const values: Record<string, string> = {};
  for (const place of PLACES) values[place] = String(formData.get(place) ?? "");
  const { counted, problems } = readBoxes(values);
  if (problems.length > 0) return { error: problems.join(" ") };
  if (Object.keys(counted).length === 0) return { error: "Type how many there are in at least one place." };

  const existing = await getModel(model);
  const result = await saveCount(user.id, [{ model, counted, description, allowNew: true }], "count screen");
  if (!result.ok) return { error: result.problems.join(" ") };
  refresh();
  return existing
    ? { ok: `${model} was already on the list, so this is saved as its count (what is there now). Its description was not changed.` }
    : { ok: `${model} added and counted. It is flagged until somebody fills in its details.`, model };
}

async function fileFrom(formData: FormData): Promise<{ file: File; buffer: ArrayBuffer } | { error: string }> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the file first." };
  if (file.size > MAX_BYTES) return { error: "That file is too big to be the right one." };
  return { file, buffer: await file.arrayBuffer() };
}

/** A filled-in count sheet. Nothing is saved unless every row is readable. */
export async function uploadCount(_prev: FormState, formData: FormData): Promise<FormState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: NOT_ALLOWED };
  }
  const got = await fileFrom(formData);
  if ("error" in got) return { error: got.error };

  const { entries, problems } = await readCountSheet(got.buffer);
  if (problems.length > 0) {
    return { error: "Nothing was saved. Fix these and upload it again:", details: problems.slice(0, 50) };
  }
  if (entries.length === 0) return { error: "No numbers were found. Is the count sheet filled in?" };

  const result = await saveCount(user.id, entries, `count sheet ${got.file.name}`);
  if (!result.ok) return { error: result.problems.join(" ") };
  refresh();
  return {
    ok: `Saved the count of ${result.models} model(s): ${result.changed} place(s) changed.`,
    details:
      result.added.length > 0
        ? [`Added and flagged for their details (not on the list before): ${result.added.join(", ")}.`]
        : undefined,
  };
}

/**
 * Invicta's master file, loaded into the catalogue.
 *
 * Arrives as rows, read in the browser: the real file is 24 MB of pictures,
 * far over what the site accepts, and the catalogue needs none of them.
 * Checked here as untrusted input all the same.
 */
export async function uploadMasterRows(fileName: string, sheets: SheetRows): Promise<FormState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: NOT_ALLOWED };
  }
  const plain = (v: unknown) => v === null || typeof v === "string" || typeof v === "number";
  const shapeOk =
    Array.isArray(sheets) &&
    sheets.length <= 20 &&
    sheets.every(
      (s) =>
        typeof s?.sheet === "string" &&
        Array.isArray(s.rows) &&
        s.rows.length <= 10_000 &&
        s.rows.every((r) => r && typeof r.line === "number" && r.values && Object.values(r.values).every(plain)),
    );
  if (!shapeOk) return { error: "That file could not be read as Invicta's master file." };

  const r = await importMaster(user.id, String(fileName).slice(0, 200), sheets);
  if (!r.ok) return { error: r.problems.join(" ") };
  refresh();
  const details: string[] = [];
  if (r.costsFilled > 0) details.push(`${r.costsFilled} missing cost(s) filled in. Costs already set were not changed.`);
  if (r.flagged > 0) details.push(`${r.flagged} model(s) have no description and are flagged until they get one.`);
  if (r.skipped.length > 0) {
    details.push(`${r.skipped.length} row(s) skipped, because what is in their model column cannot be a model number:`);
    details.push(...r.skipped.slice(0, 20));
  }
  return {
    ok: `Catalogue loaded: ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged.`,
    details: details.length > 0 ? details : undefined,
  };
}

/* ------------------------------------------------------------------ pictures */

export interface PictureState {
  error?: string;
  ok?: string;
}

/** A photo of the model, already shrunk by the page. Replaces any photo it had. */
export async function uploadPhoto(model: string, formData: FormData): Promise<PictureState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: NOT_ALLOWED };
  }
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose or take a photo first." };
  const r = await savePhoto(user.id, model, new Uint8Array(await file.arrayBuffer()));
  if (!r.ok) return { error: r.problem };
  refresh();
  return { ok: "Photo saved." };
}

/** Back to the master's link. */
export async function deletePhoto(model: string): Promise<PictureState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: NOT_ALLOWED };
  }
  const r = await removePhoto(user.id, model);
  if (!r.ok) return { error: r.problem };
  refresh();
  return { ok: "Photo removed." };
}

/** The picture link, typed or pasted. Blank clears it. */
export async function savePictureLink(model: string, link: string): Promise<PictureState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: NOT_ALLOWED };
  }
  const r = await setImageUrl(user.id, model, String(link ?? "").slice(0, 2000));
  if (!r.ok) return { error: r.problem };
  refresh();
  return { ok: link.trim() ? "Link saved." : "Link cleared." };
}

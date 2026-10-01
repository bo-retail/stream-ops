"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { isBlankRow, readAdjustment, readMove, readReturn } from "@/lib/domain/movements";
import type { Adjustment, Move, ReturnRow, Row } from "@/lib/domain/movements";
import { getPrompts, readTemplate, saveAdjustments, saveMoves, saveReturns, undoEntry } from "@/lib/server/movements";
import type { Kind, SaveResult } from "@/lib/server/movements";

/** Admins and shipping directors only — by role, never by name. */
const NOT_ALLOWED = "Only an admin or a shipping director can change stock.";
const MAX_BYTES = 15 * 1024 * 1024;

export interface MovementState {
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

const KINDS: Kind[] = ["MOVES", "ADJUSTMENTS", "RETURNS"];

/**
 * The one checker and the one write path for a kind, so typed rows and an
 * uploaded template behave the same (build rule 11).
 */
async function save(userId: string, kind: Kind, rows: { line?: number; row: Row }[], source: string): Promise<MovementState> {
  const problems: string[] = [];
  const at = (line?: number) => (line ? `Row ${line}: ` : "");
  let result: SaveResult;
  if (kind === "MOVES") {
    const ok: Move[] = [];
    for (const { line, row } of rows) {
      if (isBlankRow(row)) continue;
      const r = readMove(row);
      if (r.ok) ok.push(r.move);
      else problems.push(`${at(line)}${r.why}.`);
    }
    if (problems.length > 0) return { error: "Nothing was saved. Fix these:", details: problems.slice(0, 50) };
    result = await saveMoves(userId, ok, source);
  } else if (kind === "ADJUSTMENTS") {
    const ok: Adjustment[] = [];
    for (const { line, row } of rows) {
      if (isBlankRow(row)) continue;
      const r = readAdjustment(row);
      if (r.ok) ok.push(r.adjustment);
      else problems.push(`${at(line)}${r.why}.`);
    }
    if (problems.length > 0) return { error: "Nothing was saved. Fix these:", details: problems.slice(0, 50) };
    result = await saveAdjustments(userId, ok, source);
  } else {
    const ok: ReturnRow[] = [];
    for (const { line, row } of rows) {
      if (isBlankRow(row)) continue;
      const r = readReturn(row);
      if (r.ok) ok.push(r.ret);
      else problems.push(`${at(line)}${r.why}.`);
    }
    if (problems.length > 0) return { error: "Nothing was saved. Fix these:", details: problems.slice(0, 50) };
    result = await saveReturns(userId, ok, source);
  }
  if (!result.ok) return { error: "Nothing was saved:", details: result.problems.slice(0, 50) };
  revalidatePath("/inventory", "layout");
  return { ok: `Saved ${result.saved} row(s).`, details: result.done.slice(0, 50) };
}

/** Rows typed on the page. */
export async function saveTyped(kind: Kind, rows: Row[]): Promise<MovementState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  if (!KINDS.includes(kind) || !Array.isArray(rows) || rows.length > 500) return { error: "Those rows could not be read." };
  const clean = rows.map((r) =>
    Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [String(k), v === null || v === undefined ? null : String(v).slice(0, 500)])),
  );
  return save(user.id, kind, clean.map((row) => ({ row })), "typed on the site");
}

/** A filled-in template. */
export async function uploadTemplate(kind: Kind, _prev: MovementState, formData: FormData): Promise<MovementState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  if (!KINDS.includes(kind)) return { error: "Unknown template." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the file first." };
  if (file.size > MAX_BYTES) return { error: "That file is too big to be the right one." };
  const t = await readTemplate(kind, await file.arrayBuffer());
  if (t.problem) return { error: t.problem };
  if (t.rows.every((r) => isBlankRow(r.row))) return { error: "The sheet has no rows filled in." };
  return save(user.id, kind, t.rows, file.name.slice(0, 200));
}

export async function undo(entryId: string): Promise<MovementState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  const r = await undoEntry(user.id, String(entryId));
  if (!r.ok) return { error: r.problem };
  revalidatePath("/inventory", "layout");
  return { ok: "Undone." };
}

/**
 * Gladys said yes to a prompt. The moves are worked out again here, from stock
 * as it stands now, rather than taken from the page.
 */
export async function acceptPrompt(model: string, kind: string): Promise<MovementState> {
  const user = await director();
  if (!user) return { error: NOT_ALLOWED };
  const prompt = (await getPrompts()).find((p) => p.model === model && p.kind === kind);
  if (!prompt || prompt.moves.length === 0) return { error: "Nothing to do any more — stock has changed. Refresh the page." };
  const r = await saveMoves(user.id, prompt.moves.map((m) => ({ ...m, note: "Asked by the app, confirmed" })), "prompt on the movements page");
  if (!r.ok) return { error: "Nothing was saved:", details: r.problems };
  revalidatePath("/inventory", "layout");
  return { ok: "Recorded.", details: r.done };
}

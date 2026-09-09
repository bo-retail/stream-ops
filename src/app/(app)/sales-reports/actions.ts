"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { isDateISO } from "@/lib/domain/dates";
import { readFiles, runImport } from "@/lib/server/imports";
import { deleteImport } from "@/lib/server/shipping";
import type { ImportFlag } from "@/lib/domain/imports/types";

export interface UploadState {
  error?: string;
  ok?: string;
  flags?: ImportFlag[];
  showDate?: string;
}

/** Anything larger than this is not one morning's order exports. */
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_FILES = 6;

/**
 * Takes the morning's exports and writes the day.
 *
 * Every rule about *what* the files mean lives in `src/lib/domain/imports` and
 * is tested against real exports. This only handles the parts that are the
 * web's problem: who may do it, how big the upload may be, and turning the
 * result into something readable.
 */
export async function uploadReports(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: "Only the shipping director or an admin can upload reports." };
  }

  const uploads = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const forDay = String(formData.get("showDate") ?? "").trim();

  if (uploads.length === 0) return { error: "Pick the export files first." };
  if (uploads.length > MAX_FILES) {
    return { error: `That is ${uploads.length} files — more than any one show day produces.` };
  }
  if (forDay !== "" && !isDateISO(forDay)) {
    return { error: "That is not a valid show day." };
  }

  const total = uploads.reduce((n, f) => n + f.size, 0);
  if (total > MAX_BYTES) {
    return { error: `That is ${Math.round(total / 1024 / 1024)} MB of files. Check they are the right ones.` };
  }

  const files = await Promise.all(
    uploads.map(async (file) => ({ name: file.name, text: await file.text() })),
  );

  /*
    The day is still read out of the orders, never taken on trust — but when a
    day has been chosen on screen, the two have to agree.

    This is the check that catches the real mistake: picking Tuesday, reaching
    for Monday's downloads, and putting a day's boxes on the wrong date. Reading
    the files first means the answer comes from the orders and the choice is
    only ever a confirmation of it.
  */
  if (forDay !== "") {
    const preview = readFiles(files);
    if (preview.showDate !== null && preview.showDate !== forDay) {
      return {
        error:
          `Those files are the orders for ${preview.showDate}, but ${forDay} was selected. ` +
          `Nothing was imported. Pick ${preview.showDate} above, or choose the other files.`,
        showDate: preview.showDate,
      };
    }
  }

  let outcome;
  try {
    outcome = await runImport(files, user.id);
  } catch (error) {
    // A failed import must not look like a successful empty one.
    return {
      error: `The upload could not be completed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }

  await prisma.auditLog.create({
    data: {
      entityType: "ImportBatch",
      entityId: outcome.batchId ?? "none",
      action: outcome.status === "OK" ? "IMPORT" : "IMPORT_BLOCKED",
      actorId: user.id,
      summary:
        outcome.status === "OK"
          ? `Uploaded the reports for ${outcome.showDate} — ${outcome.watchCount} watches in ${outcome.boxCount} boxes`
          : `Upload for ${outcome.showDate ?? "an unreadable day"} was refused: ${
              outcome.flags.find((f) => f.severity === "blocking")?.message ?? "unknown"
            }`,
    },
  });

  revalidatePath("/sales-reports");
  revalidatePath("/shipping");
  revalidatePath("/shipping/log");
  revalidatePath("/dashboard");

  if (outcome.status === "BLOCKED") {
    return {
      error: "Nothing was imported — see below.",
      flags: outcome.flags,
      showDate: outcome.showDate ?? undefined,
    };
  }

  const kept =
    outcome.untouchedClosedBoxes > 0
      ? ` ${outcome.untouchedClosedBoxes} box(es) already sent were left untouched.`
      : "";

  return {
    ok:
      `${outcome.watchCount} watches in ${outcome.boxCount} boxes for ${outcome.showDate}.` +
      ` ${outcome.droppedCount} row(s) not counted.${kept}`,
    flags: outcome.flags,
    showDate: outcome.showDate ?? undefined,
  };
}

/**
 * Removes an upload and everything it created.
 *
 * For the wrong files or the wrong day, noticed straight away. It refuses once
 * anybody has scanned against the day — see `deleteImport`.
 */
export async function removeReport(batchId: string): Promise<UploadState> {
  let user;
  try {
    user = await requireShippingDirectorOrThrow();
  } catch {
    return { error: "Only the shipping director or an admin can remove a report." };
  }

  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { showDate: true, watchCount: true },
  });
  if (!batch) return { error: "That upload no longer exists." };

  const result = await deleteImport(batchId);
  if (!result.ok) return { error: result.reason };

  await prisma.auditLog.create({
    data: {
      entityType: "ImportBatch",
      entityId: batchId,
      action: "IMPORT_DELETED",
      actorId: user.id,
      summary: `Removed the sales report for ${batch.showDate.toISOString().slice(0, 10)} — ${batch.watchCount} watches and ${result.boxesRemoved} unpacked boxes`,
    },
  });

  revalidatePath("/sales-reports");
  revalidatePath("/shipping");
  revalidatePath("/shipping/log");
  revalidatePath("/dashboard");

  return { ok: `Removed. ${result.boxesRemoved} box(es) went with it.` };
}

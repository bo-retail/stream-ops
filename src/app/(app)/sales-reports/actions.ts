"use server";

import { revalidatePath } from "next/cache";
import { requireShippingDirectorOrThrow } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { runImport } from "@/lib/server/imports";
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

  if (uploads.length === 0) return { error: "Pick the morning's export files first." };
  if (uploads.length > MAX_FILES) {
    return { error: `That is ${uploads.length} files. A morning is two TikTok exports and one eBay one.` };
  }

  const total = uploads.reduce((n, f) => n + f.size, 0);
  if (total > MAX_BYTES) {
    return { error: `That is ${Math.round(total / 1024 / 1024)} MB of files. Check they are the right ones.` };
  }

  const files = await Promise.all(
    uploads.map(async (file) => ({ name: file.name, text: await file.text() })),
  );

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

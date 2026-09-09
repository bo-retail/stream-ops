"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Alert, Button } from "@/components/ui";
import { getRemovalImpact, removeReport } from "./actions";
import type { RemovalImpact } from "@/lib/server/shipping";

/**
 * Undoes an upload — the wrong files, or the wrong day.
 *
 * It asks what is actually there before asking whether to go ahead, because
 * "remove the report" means different things depending on whether anybody has
 * packed against it. Nothing packed, and it is tidying up. Boxes packed, and it
 * destroys the scan record for those parcels — which is the answer to a
 * customer dispute, and gone for good.
 *
 * So that case asks for a reason rather than a confirmation. The reason
 * survives on the audit log after the detail it describes has gone.
 */
export function RemoveReport({ batchId, dateISO }: { batchId: string; dateISO: string }) {
  const [impact, setImpact] = useState<RemovalImpact | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function ask() {
    startTransition(async () => {
      const result = await getRemovalImpact(batchId);
      if (!result) setError("That upload no longer exists.");
      else setImpact(result);
    });
  }

  function close() {
    setImpact(null);
    setReason("");
    setError(null);
  }

  if (impact) {
    const destructive = impact.scans > 0;
    return (
      <div className="w-full space-y-2 rounded-lg border border-danger-200 bg-danger-50 p-3 text-left">
        <p className="text-sm font-semibold text-danger-700">Remove the report for {dateISO}?</p>
        <p className="text-sm text-danger-700">
          This removes {impact.watches} watch{impact.watches === 1 ? "" : "es"}, {impact.boxes} box
          {impact.boxes === 1 ? "" : "es"} and everything loaded for that day. It cannot be undone.
        </p>

        {destructive ? (
          <>
            <p className="text-sm font-medium text-danger-700">
              {impact.scannedBoxes} box{impact.scannedBoxes === 1 ? " has" : "es have"} already been
              packed. Their scan history goes too — {impact.scans} record
              {impact.scans === 1 ? "" : "s"} of what went into which parcel, and who put it there.
              That is what answers a customer who says they were sent the wrong watch.
            </p>
            <div className="space-y-1">
              <label htmlFor={`why-${batchId}`} className="block text-xs font-medium text-danger-700">
                Why is it being removed?
              </label>
              <input
                id={`why-${batchId}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. wrong day's files, nothing real was packed"
                className="h-10 w-full rounded-lg border border-danger-200 bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle focus:border-danger-400 focus:outline-none focus:ring-2 focus:ring-danger-100"
              />
              <p className="text-xs text-danger-700">
                Kept on the activity log, along with what was destroyed.
              </p>
            </div>
          </>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={pending || (destructive && reason.trim().length < 3)}
            onClick={() =>
              startTransition(async () => {
                const result = await removeReport(batchId, reason);
                if (result.error) setError(result.error);
                else {
                  close();
                  router.refresh();
                }
              })
            }
          >
            {pending ? "Removing…" : destructive ? "Remove it anyway" : "Remove it"}
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={close}>
            Keep it
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    );
  }

  return (
    <div className="text-right">
      <button
        type="button"
        disabled={pending}
        onClick={ask}
        className="inline-flex items-center gap-1 text-sm font-medium text-ink-muted underline underline-offset-2 hover:text-danger-600"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        {pending ? "Checking…" : "Remove"}
      </button>
      {error ? <Alert tone="danger" className="mt-2">{error}</Alert> : null}
    </div>
  );
}

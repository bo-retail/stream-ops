"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Alert, Button } from "@/components/ui";
import { removeReport } from "./actions";

/**
 * Undoes an upload — the wrong files, or the wrong day.
 *
 * It asks first, and says what will go, because the boxes go with it. Once
 * anybody has scanned against the day the server refuses outright and explains
 * why; there is no confirmation that gets past that.
 */
export function RemoveReport({ batchId, dateISO }: { batchId: string; dateISO: string }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (asking) {
    return (
      <div className="space-y-2 text-left">
        <p className="text-xs text-ink">
          Remove the report for {dateISO}? Its sales, its exceptions and any box nobody has
          started packing go with it.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await removeReport(batchId);
                if (result.error) setError(result.error);
                else {
                  setAsking(false);
                  router.refresh();
                }
              })
            }
          >
            {pending ? "Removing…" : "Remove it"}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => { setAsking(false); setError(null); }}>
            Keep it
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setAsking(true)}
      className="inline-flex items-center gap-1 text-sm font-medium text-ink-muted underline underline-offset-2 hover:text-danger-600"
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden />
      Remove
    </button>
  );
}

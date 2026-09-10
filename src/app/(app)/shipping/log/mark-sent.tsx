"use client";

import { useActionState, useState } from "react";
import { Card, CardHeader, Input } from "@/components/ui";
import { markDayAsSent } from "../actions";

/**
 * "This day already went out."
 *
 * Two situations need it. The days before this app had a packing screen, whose
 * reports still want loading for the sales — their boxes would otherwise sit
 * open forever and the log would read "0 sent of 220" for those days for good.
 * And a day the scanner was down, or nobody remembered to use it: the parcels
 * went out, and somebody has to be able to say so without scanning six hundred
 * labels after the fact.
 *
 * Deliberately awkward. It is behind a confirmation, it needs a reason typed in
 * before the button will do anything, and it says exactly how many boxes it is
 * about to close. Closing a day is not undoable in one action — each box would
 * have to be reopened by hand — so the friction is the point.
 */
export function MarkDaySent({
  dateISO,
  dayLabel,
  openBoxes,
}: {
  dateISO: string;
  dayLabel: string;
  openBoxes: number;
}) {
  const [state, action, pending] = useActionState(markDayAsSent, {});
  const [confirming, setConfirming] = useState(false);

  if (openBoxes === 0 && !state.ok) return null;

  return (
    <Card className="border-warn-200">
      <CardHeader
        title="These parcels already went out"
        description={`${openBoxes} box${openBoxes === 1 ? "" : "es"} on ${dayLabel} ${openBoxes === 1 ? "is" : "are"} still open. If they shipped without being scanned here, say so and they stop showing as outstanding.`}
      />

      <div className="p-4 pt-0">
        {state.ok ? (
          <p className="text-sm font-medium text-ok-700">{state.ok}</p>
        ) : !confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex h-9 items-center rounded-lg border border-warn-200 bg-warn-50 px-3 text-sm font-medium text-warn-700 hover:bg-warn-100"
          >
            Mark this day as sent
          </button>
        ) : (
          <form action={action} className="space-y-3">
            <input type="hidden" name="date" value={dateISO} />

            <div className="rounded-lg border border-warn-200 bg-warn-50 px-3 py-2.5 text-sm text-warn-700">
              <p className="font-semibold">
                This closes {openBoxes} box{openBoxes === 1 ? "" : "es"} at once.
              </p>
              <p className="mt-1">
                They will be recorded as <strong>sent, but never scanned here</strong> — not as
                checked. Nobody verified what went in them, and the scan log will say so. To undo
                it you would have to reopen each box one at a time.
              </p>
            </div>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">
                Why were these not scanned?
              </span>
              <Input
                name="reason"
                required
                minLength={3}
                maxLength={200}
                placeholder="e.g. shipped before we started using StreamOps"
                autoFocus
              />
            </label>

            {state.error ? (
              <p className="text-sm font-medium text-danger-600">{state.error}</p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={pending}
                className="inline-flex h-9 items-center rounded-lg bg-warn-500 px-3 text-sm font-medium text-white hover:brightness-95 disabled:opacity-50"
              >
                {pending ? "Marking…" : `Yes — mark ${openBoxes} sent`}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

"use client";

import { useActionState, useState } from "react";
import { Alert, Button, Input, Label } from "@/components/ui";
import { addDays } from "@/lib/domain/dates";
import { uploadStartingCount } from "./actions";
import type { StartState } from "./actions";

/** Upload the filled-in sheet and say which show day sales come off from. */
export function StartForm({ today }: { today: string }) {
  const [state, run, pending] = useActionState<StartState, FormData>(uploadStartingCount, {});
  const [sure, setSure] = useState(false);
  return (
    <form action={run} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">The filled-in count sheet</span>
        <input
          type="file"
          name="file"
          accept=".xlsx"
          required
          className="block w-full cursor-pointer rounded-lg border border-line bg-canvas p-2 text-sm text-ink file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
        />
      </label>
      <div>
        <Label htmlFor="start">Sales come off from show day</Label>
        <Input id="start" name="start" type="date" defaultValue={today} min={addDays(today, -1)} required className="max-w-xs" />
        <p className="mt-1 text-xs text-ink-muted">
          Every sale from this show day on comes off the count — including the ones in today&apos;s sold pile, so count
          that pile as well, and don&apos;t ship from it until the count is uploaded. Don&apos;t count orders from before
          this day that haven&apos;t shipped.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" className="mt-1 h-4 w-4" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        <span>
          I understand this <strong>replaces every number</strong> in inventory with the sheet&apos;s. Models not on the
          sheet become zero.
        </span>
      </label>
      <Button type="submit" disabled={pending || !sure}>
        {pending ? "Uploading…" : "Upload the starting count"}
      </Button>
      {state.error || state.ok ? (
        <Alert tone={state.error ? "danger" : "ok"}>
          {state.error ?? state.ok}
          {state.details && state.details.length > 0 ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              {state.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
    </form>
  );
}

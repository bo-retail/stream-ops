"use client";

import { useActionState } from "react";
import { Alert, Button, Input, Label } from "@/components/ui";
import { undoReturns, uploadReturns } from "./actions";
import type { ReturnsState } from "./actions";

/** One returns upload in the log, with its undo. */
export function UndoReturns({ entryId, label }: { entryId: string; label: string }) {
  const [state, run, pending] = useActionState<ReturnsState, FormData>(undoReturns, {});
  return (
    <form
      action={run}
      onSubmit={(e) => {
        if (!window.confirm(`Undo ${label}? Its pieces come back off Sellable.`)) e.preventDefault();
      }}
      className="text-right"
    >
      <input type="hidden" name="entryId" value={entryId} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Undoing…" : "Undo"}
      </Button>
      {state.error ? <p className="mt-1 text-xs text-danger-700">{state.error}</p> : null}
      {state.ok ? <p className="mt-1 text-xs text-ok-700">{state.ok}</p> : null}
    </form>
  );
}

/** Upload the filled-in returns sheet and say when they came back. */
export function ReturnsForm({ today }: { today: string }) {
  const [state, run, pending] = useActionState<ReturnsState, FormData>(uploadReturns, {});
  return (
    <form action={run} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">The filled-in returns sheet</span>
        <input
          type="file"
          name="file"
          accept=".xlsx"
          required
          className="block w-full cursor-pointer rounded-lg border border-line bg-canvas p-2 text-sm text-ink file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="name">Name these returns</Label>
          <Input id="name" name="name" maxLength={80} placeholder="e.g. Returns this week" />
          <p className="mt-1 text-xs text-ink-muted">How it shows in the log. Left empty, the file&apos;s name is used.</p>
        </div>
        <div>
          <Label htmlFor="on">Came back on</Label>
          <Input id="on" name="on" type="date" defaultValue={today} required className="max-w-xs" />
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm text-ink-muted">
        <input type="checkbox" name="confirm" className="mt-1 h-4 w-4" />
        <span>
          Yes, add it anyway. Only tick this if the upload asked: these really are other watches than the same returns
          already added today, they came back after the count on the count&apos;s own day, or the large quantities are right.
        </span>
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add back to inventory"}
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

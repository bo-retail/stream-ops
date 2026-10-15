"use client";

import { useActionState } from "react";
import { Alert, Button, Input, Label } from "@/components/ui";
import { undoDelivery, uploadReceipt } from "./actions";
import type { ReceiveState } from "./actions";

/** One delivery in the list, with its undo. */
export function UndoDelivery({ entryId, label }: { entryId: string; label: string }) {
  const [state, run, pending] = useActionState<ReceiveState, FormData>(undoDelivery, {});
  return (
    <form
      action={run}
      onSubmit={(e) => {
        if (!window.confirm(`Undo ${label}? Its pieces come back off stock.`)) e.preventDefault();
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

/** Upload the filled-in receiving sheet and say when it arrived. */
export function ReceiveForm({ today }: { today: string }) {
  const [state, run, pending] = useActionState<ReceiveState, FormData>(uploadReceipt, {});
  return (
    <form action={run} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">The filled-in receiving sheet</span>
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
          <Label htmlFor="name">Name this delivery</Label>
          <Input id="name" name="name" maxLength={80} placeholder="e.g. Invicta shipment" />
          <p className="mt-1 text-xs text-ink-muted">How it shows in the log. Left empty, the file&apos;s name is used.</p>
        </div>
        <div>
          <Label htmlFor="on">Received on</Label>
          <Input id="on" name="on" type="date" defaultValue={today} required className="max-w-xs" />
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm text-ink-muted">
        <input type="checkbox" name="confirm" className="mt-1 h-4 w-4" />
        <span>
          Yes, add it anyway. Only tick this if the upload asked: it really is another, identical delivery, it arrived
          after the starting count on the count&apos;s own day, or the very large quantities are right.
        </span>
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add to inventory"}
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

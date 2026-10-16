"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Label, Select } from "@/components/ui";
import { COUNTED_LABEL, COUNTED_PLACES } from "@/lib/domain/inventory";
import { undoReturns, uploadReturns } from "./actions";
import type { ReturnsState } from "./actions";

/** One returns upload in the log, with its undo. */
export function UndoReturns({ entryId, label }: { entryId: string; label: string }) {
  const [state, run, pending] = useActionState<ReturnsState, FormData>(undoReturns, {});
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

/**
 * Upload the filled-in returns sheet and say when they came back. A model never
 * in inventory opens a box asking where it goes; the answer is sent with the
 * same upload again. Submitted by hand, not as a form action, so the chosen
 * file stays chosen between the two.
 */
export function ReturnsForm({ today }: { today: string }) {
  const [state, run, pending] = useActionState<ReturnsState, FormData>(uploadReturns, {});
  const form = useRef<HTMLFormElement>(null);
  /*
    The box's answers. Kept for an upload straight after it (the box answered,
    then the upload asks something and "Yes, add it anyway" is ticked), and
    dropped on Cancel, on a new file, and once the returns are added — so an
    answer is never sent for a sheet nobody answered it for.
  */
  const [places, setPlaces] = useState<Record<string, string>>({});
  const [closed, setClosed] = useState<ReturnsState | null>(null);

  // Added: the form is emptied, the tick too, so a second click cannot add the same returns again unasked.
  useEffect(() => {
    if (state.ok) {
      form.current?.reset();
      setPlaces({});
    }
  }, [state]);

  const send = (answers: Record<string, string>) => {
    const data = new FormData(form.current!);
    for (const [model, place] of Object.entries(answers)) data.set(`place:${model}`, place);
    startTransition(() => run(data));
  };
  const asking = state.needsPlace && state.needsPlace.length > 0 && closed !== state ? state.needsPlace : null;
  const answered = asking?.every((n) => places[n.model]) ?? false;

  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        send(places);
      }}
      className="space-y-4"
    >
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">The filled-in returns sheet</span>
        <input
          type="file"
          name="file"
          accept=".xlsx"
          required
          onChange={() => setPlaces({})}
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
      {state.needsPlace && state.needsPlace.length > 0 && !asking ? (
        <Alert tone="danger">Nothing was added: a model never in inventory needs a place. Upload again to choose it.</Alert>
      ) : null}

      {asking ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="never-title">
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-surface p-5 shadow-xl">
            <h2 id="never-title" className="text-base font-semibold text-ink">
              {asking.length === 1 ? "This model has never been in inventory" : "These models have never been in inventory"}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              Check the number against the watch first. If it is right, where should it go? Nothing is added until you choose.
            </p>
            <ul className="mt-4 space-y-3">
              {asking.map((n) => (
                <li key={n.model}>
                  <Label htmlFor={`place-${n.model}`}>
                    {n.model} × {n.qty}
                  </Label>
                  <Select
                    id={`place-${n.model}`}
                    value={places[n.model] ?? ""}
                    onChange={(e) => setPlaces((p) => ({ ...p, [n.model]: e.target.value }))}
                  >
                    <option value="" disabled>
                      Choose where it goes…
                    </option>
                    {COUNTED_PLACES.map((p) => (
                      <option key={p} value={p}>
                        {COUNTED_LABEL[p]}
                      </option>
                    ))}
                  </Select>
                </li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => {
                  setClosed(state);
                  setPlaces({});
                }}>
                Cancel
              </Button>
              <Button type="button" disabled={!answered || pending} onClick={() => send(places)}>
                {pending ? "Adding…" : "Add back to inventory"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}

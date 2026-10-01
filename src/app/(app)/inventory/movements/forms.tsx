"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Input, Select } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { fetchPictures } from "../../shipping/use-box-pictures";
import type { Kind } from "@/lib/server/movements";
import { acceptPrompt, notYet, saveTyped, undo, uploadTemplate } from "./actions";
import type { MovementState } from "./actions";

export function Result({ state }: { state: MovementState }) {
  if (!state.error && !state.ok) return null;
  return (
    <Alert tone={state.error ? "danger" : "ok"}>
      {state.error ?? state.ok}
      {state.details && state.details.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {state.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

export type Field = { name: string; label: string; options?: readonly string[]; width: string; numeric?: boolean };

/**
 * Rows typed on the page — the main way in. The same columns as the template,
 * so a row typed and a row uploaded are read by the same checker. Each row
 * shows the watch's picture once its model number is in.
 */
export function RowsForm({ kind, fields, saveLabel }: { kind: Kind; fields: Field[]; saveLabel: string }) {
  const router = useRouter();
  const blank = () => Object.fromEntries(fields.map((f) => [f.name, f.options ? f.options[0] : ""])) as Record<string, string>;
  const [rows, setRows] = useState<Record<string, string>[]>([blank()]);
  const [pictures, setPictures] = useState<Record<string, string>>({});
  const [state, setState] = useState<MovementState>({});
  const [busy, setBusy] = useState(false);

  const set = (i: number, name: string, value: string) => setRows((all) => all.map((r, j) => (j === i ? { ...r, [name]: value } : r)));
  async function lookUp(model: string) {
    const m = model.trim().toUpperCase();
    if (!m || m in pictures) return;
    try {
      const found = await fetchPictures([m]);
      setPictures((p) => ({ ...p, [m]: found[m] ?? "" }));
    } catch {
      // No picture this time; the row works without one.
    }
  }

  return (
    <form
      className="space-y-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setState({});
        try {
          // A row left untouched (only its dropdowns' defaults) is not a row.
          const typed = rows.filter((r) => fields.some((f) => !f.options && (r[f.name] ?? "").trim() !== ""));
          if (typed.length === 0) {
            setState({ error: "Type a model and how many first." });
            return;
          }
          const r = await saveTyped(kind, typed);
          setState(r);
          if (r.ok) {
            setRows([blank()]);
            router.refresh();
          }
        } catch {
          setState({ error: "That did not save. Check the connection and try again; nothing was half-saved." });
        } finally {
          setBusy(false);
        }
      }}
    >
      {rows.map((row, i) => {
        const model = (row["Model #"] ?? "").trim().toUpperCase();
        return (
          <div key={i} className="flex flex-wrap items-end gap-2 border-b border-line pb-3 last:border-0">
            <WatchImage url={pictures[model]} model={model || "watch"} size={40} />
            {fields.map((f) => (
              <label key={f.name} className={f.width}>
                <span className="block text-xs text-ink-muted">{f.label}</span>
                {f.options ? (
                  <Select value={row[f.name]} onChange={(e) => set(i, f.name, e.target.value)}>
                    {f.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    value={row[f.name]}
                    inputMode={f.numeric ? "numeric" : undefined}
                    onChange={(e) => set(i, f.name, e.target.value)}
                    onBlur={f.name === "Model #" ? (e) => void lookUp(e.target.value) : undefined}
                  />
                )}
              </label>
            ))}
            {rows.length > 1 ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setRows((all) => all.filter((_, j) => j !== i))}>
                Remove
              </Button>
            ) : null}
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : saveLabel}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setRows((all) => [...all, blank()])}>
          Another row
        </Button>
      </div>
      <Result state={state} />
    </form>
  );
}

const FILE_INPUT =
  "block w-full cursor-pointer rounded-lg border border-line bg-canvas p-2 text-sm text-ink file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white";

export function UploadTemplate({ kind }: { kind: Kind }) {
  const [state, run, pending] = useActionState<MovementState, FormData>(uploadTemplate.bind(null, kind), {});
  return (
    <form action={run} className="space-y-2">
      <input type="file" name="file" accept=".xlsx" required className={FILE_INPUT} aria-label="Filled-in template" />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Uploading…" : "Upload the template"}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function UndoButton({ entryId }: { entryId: string }) {
  const router = useRouter();
  const [state, setState] = useState<MovementState>({});
  const [busy, setBusy] = useState(false);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm("Undo this whole save? Every change in it is reversed (nothing is deleted from the history).")) return;
          setBusy(true);
          try {
            const r = await undo(entryId);
            setState(r);
            if (r.ok) router.refresh();
          } catch {
            setState({ error: "That did not work. Try again." });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Undoing…" : "Undo"}
      </Button>
      {state.error ? <span className="text-xs text-danger-600">{state.error}</span> : null}
    </span>
  );
}

/** "Yes, record it" on a prompt, or "Not yet". Nothing moves until Gladys says so. */
export function PromptButton({ model, kind, label }: { model: string; kind: string; label: string }) {
  const router = useRouter();
  const [state, setState] = useState<MovementState>({});
  const [busy, setBusy] = useState(false);
  return (
    <span className="inline-flex flex-wrap items-start gap-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await notYet(model, kind);
            router.refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        Not yet
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await acceptPrompt(model, kind);
            setState(r);
            if (r.ok) router.refresh();
          } catch {
            setState({ error: "That did not save. Try again." });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Saving…" : label}
      </Button>
      {state.error ? <span className="text-xs text-danger-600">{state.error}</span> : null}
    </span>
  );
}

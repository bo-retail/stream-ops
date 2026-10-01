"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, CardHeader, Input, LinkButton } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { PLACES, PLACE_LABEL } from "@/lib/domain/inventory";
import type { Place, Where } from "@/lib/domain/inventory";
import { addAndCount, countOne } from "../actions";
import type { FormState } from "../actions";

interface Model {
  model: string;
  description: string;
  picture: string;
  countedToday: boolean;
  balances: Record<Where, number>;
}

/** How many rows to show at once. Enough to work through, few enough to stay quick. */
const SHOWN = 40;

/**
 * The list to count from.
 *
 * Search narrows it to the model in your hand. With nothing typed it shows the
 * models not counted today, so a full count can work down the list — and the
 * next count starts with the full list again.
 */
export function CountList({ models, initialSearch }: { models: Model[]; initialSearch: string }) {
  const [search, setSearch] = useState(initialSearch);
  const [rows, setRows] = useState(models);
  // Fresh numbers from the server (a watch just added, someone else's count)
  // replace the list without clearing the search or anything being typed.
  useEffect(() => setRows(models), [models]);

  const shown = useMemo(() => {
    const q = search.trim().toUpperCase();
    const list = q
      ? rows.filter((m) => m.model.includes(q) || m.description.toUpperCase().includes(q))
      : rows.filter((m) => !m.countedToday);
    // An exact model number first, so typing one puts it at the top.
    return [...list].sort((a, b) => Number(b.model === q) - Number(a.model === q)).slice(0, SHOWN);
  }, [rows, search]);
  const left = rows.filter((m) => !m.countedToday).length;

  return (
    <Card>
      <CardHeader
        title="Models"
        description={`${left.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")} not counted today. The grey numbers in the boxes are what the app has now.`}
      />
      <div className="border-b border-line p-3">
        <Input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Type or scan a model number"
          aria-label="Find a model"
          className="max-w-sm"
        />
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-muted">
          {search ? "No model matches that. If the watch is not on the list, add it below." : "Every model has been counted today."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((m) => (
            <CountRow
              key={m.model}
              model={m}
              onSaved={(balances) =>
                setRows((all) => all.map((x) => (x.model === m.model ? { ...x, balances } : x)))
              }
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function CountRow({ model, onSaved }: { model: Model; onSaved: (b: Record<Where, number>) => void }) {
  const [values, setValues] = useState<Partial<Record<Place, string>>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const r = await countOne(model.model, values);
    setSaving(false);
    if (r.error) {
      setMessage({ tone: "danger", text: r.error });
      return;
    }
    setMessage({ tone: "ok", text: r.ok ?? "Saved." });
    setValues({});
    if (r.balances) onSaved(r.balances);
  }

  return (
    <li className="px-4 py-3">
      <form onSubmit={save} className="flex flex-wrap items-end gap-3">
        {/* Big enough to tell the watch in hand from its neighbours on the list. */}
        <WatchImage url={model.picture} model={model.model} size={64} />
        <div className="w-44 min-w-0">
          <p className="tabular font-semibold text-ink">{model.model}</p>
          <p className="truncate text-xs text-ink-muted">{model.description || "—"}</p>
        </div>
        {PLACES.map((place) => (
          <label key={place} className="w-24">
            <span className="block text-xs text-ink-muted">{PLACE_LABEL[place]}</span>
            <input
              inputMode="numeric"
              value={values[place] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [place]: e.target.value }))}
              placeholder={String(model.balances[place])}
              aria-label={`${model.model} ${PLACE_LABEL[place]}`}
              className="tabular h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </label>
        ))}
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {model.balances.WAITING > 0 ? (
          <span className="w-full text-xs font-medium text-brand-700">
            {model.balances.WAITING} sold, waiting to ship — set aside, do not count {model.balances.WAITING === 1 ? "it" : "them"}.
          </span>
        ) : null}
        {message ? (
          <span className={`text-sm font-medium ${message.tone === "ok" ? "text-ok-700" : "text-danger-600"}`}>
            {message.text}
          </span>
        ) : model.countedToday ? (
          <span className="text-xs text-ink-subtle">Counted today</span>
        ) : null}
      </form>
    </li>
  );
}

/** A watch on the shelf that is not on the list. */
export function AddModel() {
  const [state, action, pending] = useActionState<FormState, FormData>(addAndCount, {});
  const router = useRouter();
  // A watch just added belongs in the list above straight away.
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state, router]);
  return (
    <Card>
      <CardHeader
        title="A watch that is not on the list"
        description="Add it with its count. It is flagged until somebody fills in its details from the master file."
      />
      <form action={action} className="flex flex-wrap items-end gap-3 p-4">
        <label className="w-36">
          <span className="block text-xs text-ink-muted">Model number</span>
          <Input name="model" required />
        </label>
        <label className="w-64">
          <span className="block text-xs text-ink-muted">What it is</span>
          <Input name="description" placeholder="e.g. Pro Diver 40mm, blue" />
        </label>
        {PLACES.map((place) => (
          <label key={place} className="w-24">
            <span className="block text-xs text-ink-muted">{PLACE_LABEL[place]}</span>
            <Input name={place} inputMode="numeric" />
          </label>
        ))}
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Adding…" : "Add and count"}
        </Button>
      </form>
      {state.error ? (
        <div className="px-4 pb-4">
          <Alert tone="danger">{state.error}</Alert>
        </div>
      ) : null}
      {state.ok ? (
        <div className="px-4 pb-4">
          <Alert tone="ok">{state.ok}</Alert>
          {state.model ? (
            <LinkButton href={`/inventory/${encodeURIComponent(state.model)}`} className="mt-2">
              Add its photo
            </LinkButton>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

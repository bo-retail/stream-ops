"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardHeader, Input } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { countShipment } from "../actions";
import type { ReceivingState } from "../actions";
import { Result } from "../forms";

export interface CountLine {
  model: string;
  description: string;
  picture: string;
  listed: number;
  priceCents: number | null;
  offerCents: number | null;
  counted: number | null;
  damaged: number | null;
}

const usd = (c: number | null) => (c === null ? "—" : `$${(c / 100).toFixed(2)}`);
const BOX =
  "tabular h-9 w-20 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100";

/**
 * The shipment count, typed — the main way to count one in.
 *
 * One row per model on the list, with its picture to match against the watch
 * in hand. Counted is everything that came out of the boxes for it, damaged
 * ones included; a blank row has not been counted yet and is left alone. A
 * model that came without being on the list is added at the bottom.
 */
export function CountForm({ sop, lines }: { sop: string; lines: CountLine[] }) {
  const router = useRouter();
  const start = () =>
    Object.fromEntries(
      lines.map((l) => [l.model, { counted: l.counted === null ? "" : String(l.counted), damaged: l.counted === null || !l.damaged ? "" : String(l.damaged) }]),
    );
  const [values, setValues] = useState<Record<string, { counted: string; damaged: string }>>(start);
  const [extra, setExtra] = useState<{ model: string; counted: string; damaged: string }[]>([]);
  const [state, setState] = useState<ReceivingState>({});
  const [busy, setBusy] = useState(false);

  const set = (model: string, key: "counted" | "damaged", v: string) =>
    setValues((all) => ({ ...all, [model]: { ...all[model], [key]: v } }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setState({});
    try {
      const rows = [
        ...lines
          .filter((l) => {
            const v = values[l.model];
            // Only what was typed or changed is sent: an untouched counted row is not re-saved.
            return v.counted !== (l.counted === null ? "" : String(l.counted)) || v.damaged !== (l.counted === null || !l.damaged ? "" : String(l.damaged));
          })
          .map((l) => ({ model: l.model, ...values[l.model] })),
        ...extra.filter((x) => x.model.trim() !== ""),
      ];
      if (rows.length === 0) {
        setState({ error: "Nothing new to save: type a count first." });
        return;
      }
      const r = await countShipment(sop, rows);
      setState(r);
      if (r.ok) {
        setExtra([]);
        router.refresh();
      }
    } catch {
      setState({ error: "That did not save. Check the connection and try again; nothing was half-saved." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Count it in"
        description="Count what came out of the boxes. Counted includes the damaged ones. Leave a model blank until it is counted. You can save part of it and come back."
      />
      <form onSubmit={save}>
        <ul className="divide-y divide-line">
          {lines.map((l) => {
            const priceDiffers = l.offerCents !== null && l.priceCents !== null && l.offerCents !== l.priceCents;
            return (
              <li key={l.model} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <WatchImage url={l.picture} model={l.model} size={56} />
                <div className="w-52 min-w-0">
                  <p className="tabular font-semibold text-ink">{l.model}</p>
                  <p className="truncate text-xs text-ink-muted">{l.description || "—"}</p>
                </div>
                <div className="w-24 text-sm">
                  <span className="block text-xs text-ink-muted">On the list</span>
                  <span className="tabular font-medium">{l.listed === 0 ? "not listed" : l.listed}</span>
                </div>
                <div className="w-28 text-sm">
                  <span className="block text-xs text-ink-muted">Price</span>
                  <span className={`tabular ${priceDiffers ? "font-semibold text-warn-700" : ""}`}>{usd(l.priceCents)}</span>
                  {priceDiffers ? <span className="block text-xs text-warn-700">offer said {usd(l.offerCents)}</span> : null}
                </div>
                <label>
                  <span className="block text-xs text-ink-muted">Counted</span>
                  <input
                    inputMode="numeric"
                    className={BOX}
                    value={values[l.model].counted}
                    onChange={(e) => set(l.model, "counted", e.target.value)}
                    aria-label={`${l.model} counted`}
                  />
                </label>
                <label>
                  <span className="block text-xs text-ink-muted">Damaged</span>
                  <input
                    inputMode="numeric"
                    className={BOX}
                    value={values[l.model].damaged}
                    onChange={(e) => set(l.model, "damaged", e.target.value)}
                    placeholder="0"
                    aria-label={`${l.model} damaged on arrival`}
                  />
                </label>
              </li>
            );
          })}
          {extra.map((x, i) => (
            <li key={i} className="flex flex-wrap items-end gap-3 bg-warn-50/40 px-4 py-2.5">
              <label className="w-40">
                <span className="block text-xs text-ink-muted">Model not on the list</span>
                <Input value={x.model} onChange={(e) => setExtra((all) => all.map((y, j) => (j === i ? { ...y, model: e.target.value } : y)))} />
              </label>
              <label>
                <span className="block text-xs text-ink-muted">Counted</span>
                <input inputMode="numeric" className={BOX} value={x.counted} onChange={(e) => setExtra((all) => all.map((y, j) => (j === i ? { ...y, counted: e.target.value } : y)))} />
              </label>
              <label>
                <span className="block text-xs text-ink-muted">Damaged</span>
                <input inputMode="numeric" className={BOX} placeholder="0" value={x.damaged} onChange={(e) => setExtra((all) => all.map((y, j) => (j === i ? { ...y, damaged: e.target.value } : y)))} />
              </label>
              <Button type="button" size="sm" variant="ghost" onClick={() => setExtra((all) => all.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-3 border-t border-line p-4">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save the count"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setExtra((all) => [...all, { model: "", counted: "", damaged: "" }])}>
            A model not on the list
          </Button>
        </div>
        <div className="px-4 pb-4">
          <Result state={state} />
        </div>
      </form>
    </Card>
  );
}

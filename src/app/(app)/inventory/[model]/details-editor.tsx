"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { saveModelDetails } from "../receiving/actions";
import type { ReceivingState } from "../receiving/actions";
import { Result } from "../receiving/forms";

export interface Details {
  brand: string;
  collection: string;
  gender: string;
  description: string;
  costCents: number | null;
  tpCents: number | null;
  msrpCents: number | null;
  weightLb: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  ebayShippingProfile: string;
  upc: string;
}

const money = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));
const show = (c: number | null) => (c === null ? "" : `$${(c / 100).toFixed(2)}`);
const num = (n: number | null) => (n === null ? "" : String(n));

/** The fields, with the product details sheet's column names, so both are read the same way. */
const FIELDS = [
  ["Description", "description", "wide"],
  ["Brand", "brand", ""],
  ["Collection", "collection", ""],
  ["Gender", "gender", ""],
  ["TP", "tpCents", "money"],
  ["MSRP", "msrpCents", "money"],
  ["Cost", "costCents", "money"],
  ["Weight (lb)", "weightLb", "num"],
  ["Length (in)", "lengthIn", "num"],
  ["Width (in)", "widthIn", "num"],
  ["Height (in)", "heightIn", "num"],
  ["eBay shipping profile", "ebayShippingProfile", ""],
  ["UPC", "upc", ""],
] as const;

const LABEL: Record<string, string> = { TP: "Target price", "eBay shipping profile": "eBay profile" };

/**
 * A model's details: read, and changed in place. The same as a row of the
 * product details sheet — what is typed replaces what is there, a blank keeps
 * it, and cost is only filled when the model has none.
 */
export function DetailsEditor({ model, details }: { model: string; details: Details }) {
  const router = useRouter();
  const start = () =>
    Object.fromEntries(
      FIELDS.map(([col, key, kind]) => {
        const v = details[key];
        return [col, kind === "money" ? money(v as number | null) : kind === "num" ? num(v as number | null) : String(v ?? "")];
      }),
    ) as Record<string, string>;
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(start);
  const [state, setState] = useState<ReceivingState>({});
  const [busy, setBusy] = useState(false);

  const shown: [string, string][] = [
    ["Brand", details.brand],
    ["Collection", details.collection],
    ["Gender", details.gender],
    ["Cost", show(details.costCents)],
    ["Target price", show(details.tpCents)],
    ["MSRP", show(details.msrpCents)],
    ["TikTok box", details.weightLb !== null ? `${details.weightLb} lb · ${details.lengthIn ?? "?"}×${details.widthIn ?? "?"}×${details.heightIn ?? "?"} in` : ""],
    ["eBay profile", details.ebayShippingProfile],
    ["UPC", details.upc],
  ];

  if (!editing) {
    return (
      <div className="p-4">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          {shown.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-muted">{label}</dt>
              <dd className="text-ink">{value || "—"}</dd>
            </div>
          ))}
        </dl>
        <Button type="button" size="sm" variant="secondary" className="mt-4" onClick={() => setEditing(true)}>
          Edit details
        </Button>
        <div className="mt-3">
          <Result state={state} />
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setState({});
        try {
          // Only what changed is sent: a blank means "keep", so a field cleared here is left as it was.
          const before = start();
          const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => v.trim() !== before[k].trim()));
          const r = await saveModelDetails(model, changed);
          setState(r);
          if (r.ok) {
            setEditing(false);
            router.refresh();
          }
        } catch {
          setState({ error: "That did not save. Check the connection and try again." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map(([col, , kind]) => (
          <label key={col} className={kind === "wide" ? "col-span-2" : ""}>
            <span className="block text-xs text-ink-muted">
              {LABEL[col] ?? col}
              {col === "Cost" && details.costCents !== null ? " (set — only a cost correction changes it)" : ""}
            </span>
            <Input
              value={values[col]}
              onChange={(e) => setValues((v) => ({ ...v, [col]: e.target.value }))}
              inputMode={kind === "money" || kind === "num" ? "decimal" : undefined}
              disabled={col === "Cost" && details.costCents !== null}
            />
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : "Save details"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setValues(start());
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </div>
      <Result state={state} />
    </form>
  );
}

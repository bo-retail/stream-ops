"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Input } from "@/components/ui";
import { saveGoal } from "./actions";

/** The morning goal, changed in place. */
export function GoalForm({ dailyDollars, marginPercent }: { dailyDollars: number; marginPercent: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [revenue, setRevenue] = useState(String(dailyDollars));
  const [margin, setMargin] = useState(String(marginPercent));
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ error?: string; ok?: string }>({});

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Change the goal</Button>
        {state.ok ? <span className="text-sm text-ok-700">{state.ok}</span> : null}
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const r = await saveGoal(revenue, margin);
          setState(r);
          if (r.ok) {
            setOpen(false);
            router.refresh();
          }
        } catch {
          setState({ error: "That did not save. Check the connection and try again." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="text-sm">
        <span className="mb-1 block text-ink-muted">Revenue a day ($)</span>
        <Input inputMode="decimal" value={revenue} onChange={(e) => setRevenue(e.target.value)} className="w-36" />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-ink-muted">Gross margin (%)</span>
        <Input inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} className="w-24" />
      </label>
      <Button size="sm" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => { setOpen(false); setState({}); }}>Cancel</Button>
      {state.error ? <Alert tone="danger" className="w-full">{state.error}</Alert> : null}
    </form>
  );
}

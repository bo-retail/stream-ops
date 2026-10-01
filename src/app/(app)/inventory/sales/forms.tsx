"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Input } from "@/components/ui";
import { saveStartDate, updateNow } from "./actions";
import type { SalesState } from "./actions";

function Message({ state }: { state: SalesState }) {
  if (!state.error && !state.ok) return null;
  return <Alert tone={state.error ? "danger" : "ok"}>{state.error ?? state.ok}</Alert>;
}

/**
 * The switch: the first show day whose sales come off stock. Asked twice,
 * because it is the moment the app starts changing stock by itself.
 */
export function StartDateForm({ current }: { current: string | null }) {
  const router = useRouter();
  const [date, setDate] = useState(current ?? "");
  const [state, setState] = useState<SalesState>({});
  const [busy, setBusy] = useState(false);

  async function save(next: string) {
    const ask = next
      ? `From the shows of ${next}, every paid order comes off stock by itself. Sales before that never do.\n\nOnly do this once the opening count is done. Go ahead?`
      : "Turn it off? New sales stop coming off stock. What already came off stays as it is — a count puts stock right if needed.";
    if (!window.confirm(ask)) return;
    setBusy(true);
    setState({});
    try {
      setState(await saveStartDate(next));
      router.refresh();
    } catch {
      setState({ error: "That did not save. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save(date);
        }}
      >
        <label className="w-48">
          <span className="mb-1 block text-xs text-ink-muted">First show day that comes off</span>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <Button type="submit" size="sm" disabled={busy || date === (current ?? "")}>
          {busy ? "Saving…" : current ? "Change it" : "Start"}
        </Button>
        {current ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save("")}>
            Turn off
          </Button>
        ) : null}
      </form>
      <Message state={state} />
    </div>
  );
}

export function UpdateNowButton() {
  const router = useRouter();
  const [state, setState] = useState<SalesState>({});
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setState({});
          try {
            setState(await updateNow());
            router.refresh();
          } catch {
            setState({ error: "That did not work. Try again." });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Updating…" : "Bring up to date now"}
      </Button>
      <Message state={state} />
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { Users } from "lucide-react";
import { Alert, Button, Card, CardHeader } from "@/components/ui";
import { cn } from "@/lib/utils";
import { setReleaseMembers } from "./actions";

export interface CastMember {
  id: string;
  name: string;
}

/**
 * Who a release goes out to, and therefore who may be seated on its shows.
 *
 * One list for both questions on purpose. Asking somebody for their
 * availability and then not offering them in the picker — or the reverse —
 * would be two settings that can disagree, and the disagreement would only
 * surface as a name mysteriously missing from a dropdown.
 *
 * A diamond release goes to the two people who work it, not to nineteen
 * streamers who will never be on it.
 */
export function ReleaseMembers({
  releaseId,
  streamers,
  selected,
  sent,
  editable,
}: {
  releaseId: string;
  streamers: CastMember[];
  /** Empty means nobody has been chosen — see `sent` for what that implies. */
  selected: string[];
  /** Whether this release has already gone out to the team. */
  sent: boolean;
  editable: boolean;
}) {
  /*
    An empty list means two completely different things, and saying the wrong
    one is worse than saying nothing.

    On a release that has already gone out, it means it went to everybody —
    which is true, because it was made before a release could be aimed. On a
    draft it just means the boss has not chosen yet, and telling them their
    brand-new release "went to everybody" would be nonsense.
  */
  const wentToEverybody = selected.length === 0 && sent;
  const notChosenYet = selected.length === 0 && !sent;

  const [chosen, setChosen] = useState<Set<string>>(
    // A legacy release starts ticked as what it actually was. A new one starts
    // empty: a diamond release wants two people ticked, not fifteen unticked.
    () => new Set(wentToEverybody ? streamers.map((s) => s.id) : selected),
  );
  const [state, setState] = useState<{ ok?: string; error?: string }>({});
  const [pending, start] = useTransition();

  const all = chosen.size === streamers.length;

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setState({});
  }

  function save() {
    start(async () => setState(await setReleaseMembers(releaseId, [...chosen])));
  }

  return (
    <Card className="mb-5">
      <CardHeader
        title="Who it goes to"
        description="They are asked for their availability, and they are the only names offered when you build the schedule."
        action={
          editable ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setChosen(all ? new Set() : new Set(streamers.map((s) => s.id)))}
            >
              {all ? "Clear all" : "Select all"}
            </Button>
          ) : null
        }
      />

      <div className="p-4">
        {wentToEverybody ? (
          <Alert tone="info" className="mb-3" title="This one went to everybody">
            It was made before a release could be aimed at particular people, so it behaves as
            though the whole team is on it. Choosing below fixes that for good.
          </Alert>
        ) : null}

        {notChosenYet ? (
          <Alert tone="warn" className="mb-3" title="Nobody is on this yet">
            Pick who works these shows. It cannot be sent out until somebody is chosen — otherwise
            it would go to the whole team, including everyone who never works this kind of show.
          </Alert>
        ) : null}

        {streamers.length === 0 ? (
          <p className="text-sm text-ink-muted">Nobody is set up as a streamer yet.</p>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {streamers.map((s) => {
              const on = chosen.has(s.id);
              return (
                <label
                  key={s.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors",
                    on
                      ? "border-brand-200 bg-brand-50 text-ink"
                      : "border-line bg-surface text-ink-muted hover:bg-canvas",
                    !editable && "cursor-default opacity-70",
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-brand-600"
                    checked={on}
                    disabled={!editable || pending}
                    onChange={() => toggle(s.id)}
                  />
                  <span className="truncate">{s.name}</span>
                </label>
              );
            })}
          </div>
        )}

        {editable ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" onClick={save} disabled={pending || chosen.size === 0}>
              <Users className="h-4 w-4" aria-hidden />
              {pending ? "Saving…" : `Save — ${chosen.size} of ${streamers.length}`}
            </Button>
            {/* Nobody is not a choice: an empty list reads as everybody, so
                saving one would send the release to the whole team. */}
            {chosen.size === 0 ? (
              <p className="text-xs text-ink-muted">Pick at least one person.</p>
            ) : null}
            {state.error ? (
              <p className="text-sm font-medium text-danger-600">{state.error}</p>
            ) : null}
            {state.ok ? <p className="text-sm font-medium text-ok-700">{state.ok}</p> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

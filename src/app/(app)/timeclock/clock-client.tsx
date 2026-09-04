"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { LogIn, LogOut } from "lucide-react";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { formatDate, formatMinutes } from "@/lib/domain/dates";
import { cn } from "@/lib/utils";
import { clockIn, clockOut } from "./actions";
import type { ClockState } from "./actions";

export interface ClockEntry {
  id: string;
  dateISO: string;
  startHM: string;
  endHM: string | null;
  paidMinutes: number | null;
  shiftLabel: string | null;
  lateMinutes: number;
  leftEarlyMinutes: number;
  note: string | null;
}

/**
 * The whole employee clock is one big button and a list of what you worked.
 *
 * No note field, no dropdowns, no forms to fill in. Somebody starting a shift
 * has one thing to do and should be able to do it without reading anything.
 * Corrections go through an admin, so there is nothing here to get wrong.
 */
function BigButton({ clockedIn }: { clockedIn: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={clockedIn ? "danger" : "primary"}
      disabled={pending}
      className="h-24 w-full text-xl font-semibold"
    >
      {clockedIn ? (
        <LogOut className="h-7 w-7" aria-hidden />
      ) : (
        <LogIn className="h-7 w-7" aria-hidden />
      )}
      {pending ? "One moment…" : clockedIn ? "Clock out" : "Clock in"}
    </Button>
  );
}

/**
 * Elapsed time, ticking.
 *
 * Rendered only after mount: the server's `now` differs from the browser's, and
 * rendering a duration on both would be a hydration mismatch.
 */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (now === null) return <span className="tabular">0:00:00</span>;

  const seconds = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return (
    <span className="tabular">
      {h}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </span>
  );
}

export function ClockPanel({
  openSince,
  shiftLabel,
  shiftHours,
  nextShift,
}: {
  openSince: string | null;
  /** The show the open entry is measured against, if any. */
  shiftLabel: string | null;
  shiftHours: string | null;
  /** The show coming up, when not clocked in. */
  nextShift: { label: string; hours: string; dateISO: string } | null;
}) {
  const [inState, inAction] = useActionState<ClockState, FormData>(clockIn, {});
  const [outState, outAction] = useActionState<ClockState, FormData>(clockOut, {});
  const router = useRouter();

  // Only the action belonging to the button currently on screen. The parent
  // remounts this when the clock state flips, so a message never outlives the
  // action that produced it.
  const state = openSince ? outState : inState;

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  return (
    <Card className={cn("p-5", openSince && "border-ok-200 bg-ok-50")}>
      {openSince ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-ok-700">You are clocked in</p>
            <Badge tone="ok">On the clock</Badge>
          </div>
          <p className="mt-2 text-5xl font-semibold tracking-tight text-ink">
            <Elapsed since={openSince} />
          </p>
          {shiftLabel ? (
            <p className="mt-1 text-sm text-ink-muted">
              {shiftLabel} · {shiftHours}
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-muted">Not against a scheduled show.</p>
          )}

          <form action={outAction} className="mt-4">
            <BigButton clockedIn />
          </form>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-ink">You are clocked out</p>
          {nextShift ? (
            <p className="mt-1 text-sm text-ink-muted">
              Next up: {nextShift.label}, {nextShift.hours}
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-muted">Nothing scheduled right now.</p>
          )}

          <form action={inAction} className="mt-4">
            <BigButton clockedIn={false} />
          </form>
        </>
      )}

      {state.error ? (
        <Alert tone="danger" className="mt-3">
          {state.error}
        </Alert>
      ) : null}
      {state.ok ? (
        <Alert tone="ok" className="mt-3">
          {state.ok}
        </Alert>
      ) : null}
    </Card>
  );
}

/** What somebody worked. Read-only: an admin fixes anything that is wrong. */
export function MyEntries({ entries }: { entries: ClockEntry[] }) {
  if (entries.length === 0) {
    return (
      <Card>
        <p className="px-4 py-10 text-center text-sm text-ink-muted">
          Nothing clocked this period yet.
        </p>
      </Card>
    );
  }

  const byDate = new Map<string, ClockEntry[]>();
  for (const entry of entries) {
    byDate.set(entry.dateISO, [...(byDate.get(entry.dateISO) ?? []), entry]);
  }

  return (
    <Card>
      <ul className="divide-y divide-line">
        {[...byDate.entries()].map(([dateISO, dayEntries]) => {
          const dayMinutes = dayEntries.reduce((m, e) => m + (e.paidMinutes ?? 0), 0);
          return (
            <li key={dateISO} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-ink">{formatDate(dateISO, "long")}</p>
                <p className="tabular text-sm font-semibold text-ink">
                  {formatMinutes(dayMinutes)}
                </p>
              </div>

              <ul className="mt-1 space-y-1">
                {dayEntries.map((entry) => (
                  <li key={entry.id} className="text-sm text-ink-muted">
                    <span className="tabular">
                      {entry.startHM}–{entry.endHM ?? "still in"}
                    </span>
                    {entry.shiftLabel ? <span> · {entry.shiftLabel}</span> : null}
                    {entry.lateMinutes > 0 ? (
                      <span className="text-warn-700"> · {entry.lateMinutes} min late</span>
                    ) : null}
                    {entry.leftEarlyMinutes > 0 ? (
                      <span className="text-warn-700">
                        {" "}
                        · left {entry.leftEarlyMinutes} min early
                      </span>
                    ) : null}
                    {entry.note ? (
                      <span className="block text-xs text-ink-subtle">{entry.note}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

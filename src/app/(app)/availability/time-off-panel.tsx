"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { CalendarOff, X } from "lucide-react";
import { Alert, Button, Card, CardHeader, Field, Input } from "@/components/ui";
import { formatDate, formatDateRange } from "@/lib/domain/dates";
import type { DateISO } from "@/lib/domain/types";
import { bookTimeOff, removeTimeOff } from "./timeOffActions";
import type { TimeOffState } from "./timeOffActions";

export interface TimeOffEntry {
  id: string;
  startDate: DateISO;
  endDate: DateISO;
  note: string | null;
  recordedByName: string | null;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Saving…" : "Book time off"}
    </Button>
  );
}

export function TimeOffPanel({
  entries,
  today,
  embedded = false,
}: {
  entries: TimeOffEntry[];
  today: DateISO;
  embedded?: boolean;
}) {
  const [state, formAction] = useActionState<TimeOffState, FormData>(bookTimeOff, {});
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  function remove(id: string) {
    startTransition(async () => {
      const result = await removeTimeOff(id);
      setRemoveError(result.error ?? null);
      if (!result.error) router.refresh();
    });
  }

  const body = (
    <div className="space-y-4">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="ok">{state.ok}</Alert> : null}
      {removeError ? <Alert tone="danger">{removeError}</Alert> : null}

      <form action={formAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_1.4fr_auto] sm:items-end">
        <Field label="From" htmlFor="startDate">
          <Input id="startDate" name="startDate" type="date" defaultValue={today} required />
        </Field>
        <Field label="To" htmlFor="endDate">
          <Input id="endDate" name="endDate" type="date" defaultValue={today} required />
        </Field>
        <Field label="Note (optional)" htmlFor="note">
          <Input id="note" name="note" placeholder="Holiday, appointment…" maxLength={200} />
        </Field>
        <SubmitButton />
      </form>

      {entries.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No time off booked. Use this for whole days you are out — the schedule skips you
          automatically.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {entry.startDate === entry.endDate
                    ? formatDate(entry.startDate, "long")
                    : formatDateRange(entry.startDate, entry.endDate)}
                </p>
                {entry.note || entry.recordedByName ? (
                  <p className="text-xs text-ink-muted">
                    {entry.note}
                    {entry.note && entry.recordedByName ? " · " : ""}
                    {entry.recordedByName ? `Booked by ${entry.recordedByName}` : ""}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => remove(entry.id)}
                aria-label="Remove this time off"
                className="shrink-0 rounded-md p-1.5 text-ink-subtle hover:bg-canvas hover:text-danger-600 disabled:opacity-50"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <CalendarOff className="h-4 w-4" aria-hidden />
            Time off
          </span>
        }
        description="Whole days you cannot work."
      />
      <div className="p-4">{body}</div>
    </Card>
  );
}

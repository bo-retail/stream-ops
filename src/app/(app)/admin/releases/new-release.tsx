"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Alert, Button, Card, CardHeader, Field, Input } from "@/components/ui";
import { createRelease } from "./actions";
import type { ReleaseState } from "./actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      <Plus className="h-4 w-4" aria-hidden />
      {pending ? "Starting…" : "Start a release"}
    </Button>
  );
}

/**
 * Starting a release is only the dates.
 *
 * Everything else — the shows, the hours, the rules — is decided on the next
 * screen, where there is room to see it. Asking for all of it in one form would
 * be a wall of inputs before the boss has even seen a calendar.
 */
export function NewReleaseForm({ defaultStart, defaultEnd }: { defaultStart: string; defaultEnd: string }) {
  const [state, action] = useActionState<ReleaseState, FormData>(createRelease, {});
  const router = useRouter();

  useEffect(() => {
    if (state.releaseId) router.push(`/admin/releases/${state.releaseId}`);
  }, [state.releaseId, router]);

  return (
    <Card>
      <CardHeader
        title="New release"
        description="Pick the dates. You choose the shows, the hours and the rules on the next screen."
      />
      <form action={action} className="grid gap-3 p-4 sm:grid-cols-[1fr_11rem_11rem_auto] sm:items-end">
        <Field label="Name it (optional)" htmlFor="name">
          <Input id="name" name="name" placeholder="Second half of September" autoComplete="off" />
        </Field>
        <Field label="From" htmlFor="startDate">
          <Input id="startDate" name="startDate" type="date" required defaultValue={defaultStart} />
        </Field>
        <Field label="To" htmlFor="endDate">
          <Input id="endDate" name="endDate" type="date" required defaultValue={defaultEnd} />
        </Field>
        <Submit />
        {state.error ? (
          <p className="text-sm font-medium text-danger-600 sm:col-span-4">{state.error}</p>
        ) : null}
      </form>
      <div className="border-t border-line px-4 py-2.5">
        <p className="text-xs text-ink-muted">
          Any dates you like — a week, ten days, a fortnight. Payroll stays on the 1st–15th and
          16th–end split whatever you pick here.
        </p>
      </div>
    </Card>
  );
}

export { Alert };

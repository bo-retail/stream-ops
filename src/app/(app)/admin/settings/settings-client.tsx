"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, CardHeader, Field, Select } from "@/components/ui";
import { SUPPORTED_TIMEZONES } from "@/lib/domain/timezones";
import type { BusinessSettings } from "@/lib/domain/types";
import { saveSettings } from "./actions";
import type { SettingsState } from "./actions";

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? busy : label}
    </Button>
  );
}

export function DefaultsForm({ settings }: { settings: BusinessSettings }) {
  const [state, action] = useActionState<SettingsState, FormData>(saveSettings, {});
  const router = useRouter();

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  return (
    <Card>
      <CardHeader
        title="Time zone"
        description="Every show time, clock-in and report is read in this zone."
      />
      <form action={action} className="space-y-3 p-4">
        <Field label="Business time zone" htmlFor="timezone">
          <Select id="timezone" name="timezone" defaultValue={settings.timezone}>
            {SUPPORTED_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Submit label="Save" busy="Saving…" />
        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        {state.ok ? <Alert tone="ok">{state.ok}</Alert> : null}
      </form>
    </Card>
  );
}

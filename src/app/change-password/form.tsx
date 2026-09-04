"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button, Field, Input } from "@/components/ui";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { changePassword } from "./actions";
import type { ChangePasswordState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? "Saving…" : "Save password"}
    </Button>
  );
}

export function ChangePasswordForm() {
  const [state, formAction] = useActionState<ChangePasswordState, FormData>(changePassword, {});

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <Field label="Current password" htmlFor="currentPassword">
        <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
      </Field>

      <Field
        label="New password"
        htmlFor="newPassword"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
      >
        <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required />
      </Field>

      <Field label="Confirm new password" htmlFor="confirmPassword">
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required />
      </Field>

      <SubmitButton />
    </form>
  );
}

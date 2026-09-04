"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { KeyRound, UserPlus } from "lucide-react";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Table, Td, Th } from "@/components/ui";
import { createTeamMember, resetUserPassword, setUserActive, setUserPosition } from "./actions";
import type { TeamState } from "./actions";
import type { Position } from "./position";

export interface TeamRow {
  id: string;
  name: string;
  email: string;
  position: Position;
  isActive: boolean;
}

function AddButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      <UserPlus className="h-4 w-4" aria-hidden />
      {pending ? "Adding…" : "Add person"}
    </Button>
  );
}

function TemporaryPasswordNotice({ value }: { value: NonNullable<TeamState["temporaryPassword"]> }) {
  return (
    <Alert tone="ok" title="Temporary password — copy it now">
      <p>
        Give this to <strong>{value.name}</strong> ({value.email}). They will be asked to choose
        their own password when they first sign in. It is not stored anywhere and cannot be shown
        again.
      </p>
      <p className="tabular mt-2 rounded-md bg-surface px-3 py-2 font-mono text-base font-semibold text-ink">
        {value.password}
      </p>
    </Alert>
  );
}

export function TeamManager({ rows }: { rows: TeamRow[] }) {
  const [createState, createAction] = useActionState<TeamState, FormData>(createTeamMember, {});
  const [rowState, setRowState] = useState<TeamState>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (createState.ok || rowState.ok) router.refresh();
  }, [createState.ok, rowState.ok, router]);

  function run(fn: () => Promise<TeamState>) {
    startTransition(async () => setRowState(await fn()));
  }

  const notice = createState.temporaryPassword ?? rowState.temporaryPassword;

  return (
    <div className="space-y-5">
      {notice ? <TemporaryPasswordNotice value={notice} /> : null}
      {rowState.error ? <Alert tone="danger">{rowState.error}</Alert> : null}
      {rowState.ok && !rowState.temporaryPassword ? <Alert tone="ok">{rowState.ok}</Alert> : null}

      <Card>
        <CardHeader title="Add someone" description="They get a temporary password to change on first sign-in." />
        <form action={createAction} className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_10rem_auto] sm:items-end">
          <Field label="Name" htmlFor="name">
            <Input id="name" name="name" required placeholder="Jordan Lee" autoComplete="off" />
          </Field>
          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" required placeholder="jordan@company.com" autoComplete="off" />
          </Field>
          <Field label="Position" htmlFor="position">
            <Select id="position" name="position" defaultValue="STREAMER">
              <option value="STREAMER">Streamer</option>
              <option value="SHIPPING">Shipping</option>
              <option value="ADMIN">Admin</option>
            </Select>
          </Field>
          <AddButton />
          {createState.error ? (
            <p className="text-sm font-medium text-danger-600 sm:col-span-4">{createState.error}</p>
          ) : null}
        </form>
      </Card>

      <Card>
        <CardHeader title="Team" description="Deactivated people keep their history but cannot sign in or be scheduled." />
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Position</Th>
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.isActive ? undefined : "opacity-60"}>
                <Td className="font-medium">{row.name}</Td>
                <Td className="text-ink-muted">{row.email}</Td>
                <Td>
                  <Select
                    className="h-8 w-32 text-xs"
                    value={row.position}
                    disabled={pending}
                    aria-label={`Position for ${row.name}`}
                    onChange={(e) => run(() => setUserPosition(row.id, e.target.value as Position))}
                  >
                    <option value="STREAMER">Streamer</option>
                    <option value="SHIPPING">Shipping</option>
                    <option value="ADMIN">Admin</option>
                  </Select>
                </Td>
                <Td>
                  {row.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">Deactivated</Badge>}
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => run(() => resetUserPassword(row.id))}
                    >
                      <KeyRound className="h-3.5 w-3.5" aria-hidden />
                      Reset password
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={row.isActive ? "danger" : "secondary"}
                      disabled={pending}
                      onClick={() => run(() => setUserActive(row.id, !row.isActive))}
                    >
                      {row.isActive ? "Deactivate" : "Reactivate"}
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

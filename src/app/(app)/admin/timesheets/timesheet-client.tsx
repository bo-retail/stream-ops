"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select } from "@/components/ui";
import { formatDate, formatMinutes } from "@/lib/domain/dates";
import { cn } from "@/lib/utils";
import { addEntry, closeOpenEntry, deleteEntry, editEntry } from "./actions";
import type { TimesheetState } from "./actions";

export interface SheetEntry {
  id: string;
  userId: string;
  userName: string;
  team: "STREAMING" | "SHIPPING";
  dateISO: string;
  startHM: string;
  endHM: string | null;
  minutes: number | null;
  clockedMinutes: number | null;
  shiftLabel: string | null;
  lateMinutes: number;
  leftEarlyMinutes: number;
  unpaidMinutes: number;
  note: string | null;
  source: "SELF" | "ADMIN";
  edited: boolean;
  version: number;
}

export interface SheetPerson {
  userId: string;
  name: string;
  team: "STREAMING" | "SHIPPING";
  entries: number;
  minutes: number;
  clockedMinutes: number;
  openEntries: number;
  lateMinutes: number;
  leftEarlyMinutes: number;
}

function Submit({
  label,
  busy,
  variant = "primary",
}: {
  label: string;
  busy: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {pending ? busy : label}
    </Button>
  );
}

function Result({ state, onDone }: { state: TimesheetState; onDone?: () => void }) {
  const router = useRouter();
  useEffect(() => {
    if (state.ok) {
      router.refresh();
      onDone?.();
    }
  }, [state.ok, router, onDone]);

  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  return null;
}

/** Correcting one entry. A reason is required — these hours become wages. */
function EditForm({ entry, onDone }: { entry: SheetEntry; onDone: () => void }) {
  const [state, action] = useActionState<TimesheetState, FormData>(editEntry, {});

  return (
    <form action={action} className="mt-2 space-y-2 rounded-lg border border-line bg-canvas p-3">
      <input type="hidden" name="entryId" value={entry.id} />
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Date" htmlFor={`date-${entry.id}`}>
          <Input
            id={`date-${entry.id}`}
            name="dateISO"
            type="date"
            defaultValue={entry.dateISO}
            className="h-8 text-sm"
            required
          />
        </Field>
        <Field label="In" htmlFor={`start-${entry.id}`}>
          <Input
            id={`start-${entry.id}`}
            name="startTime"
            type="time"
            defaultValue={entry.startHM}
            className="h-8 text-sm"
            required
          />
        </Field>
        <Field label="Out" htmlFor={`end-${entry.id}`} hint="Blank leaves it open.">
          <Input
            id={`end-${entry.id}`}
            name="endTime"
            type="time"
            defaultValue={entry.endHM ?? ""}
            className="h-8 text-sm"
          />
        </Field>
      </div>
      <Input name="note" defaultValue={entry.note ?? ""} placeholder="Note" className="h-8 text-sm" />
      <Input
        name="reason"
        placeholder="Why is this being changed? (required)"
        className="h-8 text-sm"
        required
        minLength={3}
      />
      <div className="flex items-center gap-2">
        <Submit label="Save correction" busy="Saving…" />
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <Result state={state} onDone={onDone} />
    </form>
  );
}

function DeleteForm({ entry, onDone }: { entry: SheetEntry; onDone: () => void }) {
  const [state, action] = useActionState<TimesheetState, FormData>(deleteEntry, {});

  return (
    <form action={action} className="mt-2 space-y-2 rounded-lg border border-danger-200 bg-danger-50 p-3">
      <input type="hidden" name="entryId" value={entry.id} />
      <p className="text-sm text-danger-700">
        Remove {entry.userName}&rsquo;s {entry.startHM}–{entry.endHM ?? "open"} entry? The audit log
        keeps a record.
      </p>
      <Input
        name="reason"
        placeholder="Why is this being removed? (required)"
        className="h-8 text-sm"
        required
        minLength={3}
      />
      <div className="flex items-center gap-2">
        <Submit label="Remove it" busy="Removing…" variant="danger" />
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <Result state={state} onDone={onDone} />
    </form>
  );
}

function CloseForm({ entry, onDone }: { entry: SheetEntry; onDone: () => void }) {
  const [state, action] = useActionState<TimesheetState, FormData>(closeOpenEntry, {});

  return (
    <form action={action} className="mt-2 space-y-2 rounded-lg border border-warn-200 bg-warn-50 p-3">
      <input type="hidden" name="entryId" value={entry.id} />
      <p className="text-sm text-warn-700">
        {entry.userName} clocked in at {entry.startHM} and never clocked out.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Clocked out at" htmlFor={`close-${entry.id}`}>
          <Input
            id={`close-${entry.id}`}
            name="endTime"
            type="time"
            className="h-8 text-sm"
            required
          />
        </Field>
        <Input
          name="reason"
          placeholder="Why? (required)"
          className="h-8 flex-1 text-sm"
          required
          minLength={3}
        />
        <Submit label="Close it" busy="Closing…" variant="secondary" />
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <Result state={state} onDone={onDone} />
    </form>
  );
}

function EntryRow({ entry }: { entry: SheetEntry }) {
  const [mode, setMode] = useState<"none" | "edit" | "delete" | "close">("none");
  const isOpen = entry.minutes === null;

  return (
    <li className={cn("px-4 py-2.5", isOpen && "bg-warn-50")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{entry.userName}</span>
            <span className="tabular text-sm text-ink-muted">
              {entry.startHM}–{entry.endHM ?? "still in"}
            </span>
            {entry.team === "SHIPPING" ? <Badge tone="neutral">Shipping</Badge> : null}
            {isOpen ? <Badge tone="warn">Not clocked out</Badge> : null}
            {entry.source === "ADMIN" && !entry.edited ? (
              <Badge tone="neutral">Admin entry</Badge>
            ) : null}
            {entry.edited ? <Badge tone="warn">Corrected · v{entry.version}</Badge> : null}
          </div>

          {/* What was clocked versus what counts, whenever they differ. */}
          <p className="mt-0.5 text-xs text-ink-subtle">
            {entry.shiftLabel ? <>Against {entry.shiftLabel}</> : "No scheduled show"}
            {entry.lateMinutes > 0 ? (
              <span className="text-warn-700"> · {entry.lateMinutes} min late</span>
            ) : null}
            {entry.leftEarlyMinutes > 0 ? (
              <span className="text-warn-700"> · left {entry.leftEarlyMinutes} min early</span>
            ) : null}
            {entry.unpaidMinutes > 0 ? (
              <span> · {entry.unpaidMinutes} min outside the shift, not counted</span>
            ) : null}
          </p>
          {entry.note ? <p className="mt-0.5 text-xs text-ink-subtle">{entry.note}</p> : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="tabular text-sm font-semibold text-ink">
            {entry.minutes === null ? "—" : formatMinutes(entry.minutes)}
          </span>
          {isOpen ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => setMode("close")}>
              Close
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Edit ${entry.userName}'s entry`}
            onClick={() => setMode(mode === "edit" ? "none" : "edit")}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Remove ${entry.userName}'s entry`}
            onClick={() => setMode(mode === "delete" ? "none" : "delete")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {mode === "edit" ? <EditForm entry={entry} onDone={() => setMode("none")} /> : null}
      {mode === "delete" ? <DeleteForm entry={entry} onDone={() => setMode("none")} /> : null}
      {mode === "close" ? <CloseForm entry={entry} onDone={() => setMode("none")} /> : null}
    </li>
  );
}

export function AddEntryPanel({ people }: { people: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<TimesheetState, FormData>(addEntry, {});

  return (
    <Card>
      <CardHeader
        title="Add a missed shift"
        description="For somebody who forgot to clock in."
        action={
          <Button type="button" size="sm" variant={open ? "ghost" : "secondary"} onClick={() => setOpen(!open)}>
            {open ? "Cancel" : <><Plus className="h-4 w-4" aria-hidden /> Add</>}
          </Button>
        }
      />
      {open ? (
        <form action={action} className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Who" htmlFor="add-user">
              <Select id="add-user" name="userId" defaultValue="" required>
                <option value="" disabled>
                  Pick someone…
                </option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date" htmlFor="add-date">
              <Input id="add-date" name="dateISO" type="date" required />
            </Field>
            <Field label="Clocked in" htmlFor="add-start">
              <Input id="add-start" name="startTime" type="time" required />
            </Field>
            <Field label="Clocked out" htmlFor="add-end">
              <Input id="add-end" name="endTime" type="time" required />
            </Field>
          </div>
          <Input name="note" placeholder="Note (optional)" />
          <Input name="reason" placeholder="Why is this being added? (required)" required minLength={3} />
          <Submit label="Add entry" busy="Adding…" />
          <Result state={state} onDone={() => setOpen(false)} />
        </form>
      ) : null}
    </Card>
  );
}

export function Timesheet({ entries }: { entries: SheetEntry[] }) {
  const [onlyProblems, setOnlyProblems] = useState(false);

  const visible = onlyProblems
    ? entries.filter((e) => e.minutes === null || e.edited)
    : entries;

  const byDate = new Map<string, SheetEntry[]>();
  for (const entry of visible) {
    byDate.set(entry.dateISO, [...(byDate.get(entry.dateISO) ?? []), entry]);
  }

  const problems = entries.filter((e) => e.minutes === null || e.edited).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={onlyProblems ? "primary" : "secondary"}
          onClick={() => setOnlyProblems((v) => !v)}
          disabled={problems === 0 && !onlyProblems}
        >
          {onlyProblems ? "Showing open and corrected" : `Open or corrected (${problems})`}
        </Button>
      </div>

      {byDate.size === 0 ? (
        <Card>
          <p className="px-4 py-8 text-center text-sm text-ink-muted">
            {onlyProblems ? "Nothing open or corrected." : "No hours recorded in this period."}
          </p>
        </Card>
      ) : (
        [...byDate.entries()].map(([dateISO, dayEntries]) => {
          const dayMinutes = dayEntries.reduce((m, e) => m + (e.minutes ?? 0), 0);
          return (
            <Card key={dateISO}>
              <CardHeader
                title={formatDate(dateISO, "long")}
                description={`${dayEntries.length} entr${dayEntries.length === 1 ? "y" : "ies"}`}
                action={
                  <span className="tabular text-sm font-semibold text-ink">
                    {formatMinutes(dayMinutes)}
                  </span>
                }
              />
              <ul className="divide-y divide-line">
                {dayEntries.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} />
                ))}
              </ul>
            </Card>
          );
        })
      )}
    </div>
  );
}

export function PersonTotals({ people }: { people: SheetPerson[] }) {
  const total = people.reduce((m, p) => m + p.minutes, 0);

  return (
    <Card>
      <CardHeader title="Hours per person" description="What goes to payroll." />
      <ul className="divide-y divide-line">
        {people.map((p) => (
          <li key={p.userId} className="flex items-center justify-between gap-2 px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">
                {p.name}
                {p.team === "SHIPPING" ? (
                  <span className="ml-1.5 text-xs font-normal text-ink-subtle">shipping</span>
                ) : null}
              </p>
              <p className="text-xs text-ink-subtle">
                {p.entries} shift{p.entries === 1 ? "" : "s"}
                {p.openEntries > 0 ? ` · ${p.openEntries} still open` : ""}
                {p.lateMinutes > 0 ? ` · ${p.lateMinutes} min late` : ""}
                {p.leftEarlyMinutes > 0 ? ` · ${p.leftEarlyMinutes} min early` : ""}
              </p>
            </div>
            <span
              className={cn(
                "tabular shrink-0 text-sm font-semibold",
                p.openEntries > 0 ? "text-warn-700" : "text-ink",
              )}
            >
              {formatMinutes(p.minutes)}
            </span>
          </li>
        ))}
        {people.length === 0 ? (
          <li className="px-4 py-3 text-sm text-ink-muted">Nobody clocked any hours.</li>
        ) : (
          <li className="flex items-center justify-between gap-2 border-t-2 border-line-strong px-4 py-2.5">
            <span className="text-sm font-semibold text-ink">Total</span>
            <span className="tabular text-sm font-semibold text-ink">{formatMinutes(total)}</span>
          </li>
        )}
      </ul>
    </Card>
  );
}

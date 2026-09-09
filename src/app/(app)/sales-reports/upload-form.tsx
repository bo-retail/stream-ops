"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Alert, Button, Card, CardHeader, Field, Select } from "@/components/ui";
import { formatDate } from "@/lib/domain/dates";
import { uploadReports } from "./actions";
import type { UploadState } from "./actions";

/** A show day that could be uploaded for, and what it is waiting for. */
export interface UploadTarget {
  dateISO: DateISOString;
  expects: string;
  loaded: boolean;
}
type DateISOString = string;

function UploadButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      <Upload className="h-4 w-4" aria-hidden />
      {pending ? "Reading the files…" : "Upload"}
    </Button>
  );
}

/** Flags, worst first, so a blocking one is never below a note about a gap. */
function Flags({ flags }: { flags: NonNullable<UploadState["flags"]> }) {
  const order = { blocking: 0, warning: 1, info: 2 } as const;
  const sorted = [...flags].sort((a, b) => order[a.severity] - order[b.severity]);

  return (
    <ul className="mt-3 space-y-1.5">
      {sorted.map((flag, i) => (
        <li
          key={i}
          className={
            flag.severity === "blocking"
              ? "text-sm font-medium text-danger-600"
              : flag.severity === "warning"
                ? "text-sm text-ink"
                : "text-sm text-ink-subtle"
          }
        >
          {flag.message}
        </li>
      ))}
    </ul>
  );
}

export function UploadForm({ targets }: { targets: UploadTarget[] }) {
  const [state, action] = useActionState<UploadState, FormData>(uploadReports, {});
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);

  // Land on the oldest day still waiting — that is the one somebody has to do.
  const firstMissing = targets.find((t) => !t.loaded)?.dateISO;
  const [day, setDay] = useState(firstMissing ?? targets[0]?.dateISO ?? "");

  useEffect(() => {
    if (state.ok) {
      form.current?.reset();
      router.refresh();
    }
  }, [state.ok, router]);

  const chosen = targets.find((t) => t.dateISO === day);

  return (
    <Card>
      <CardHeader
        title="Upload a day's reports"
        description="Whatever the marketplaces produced for that show day — the app works out which file is which."
      />
      <form ref={form} action={action} className="space-y-3 p-4">
        <Field label="Which show day are these for?" htmlFor="showDate">
          <Select id="showDate" name="showDate" value={day} onChange={(e) => setDay(e.target.value)}>
            {targets.length === 0 ? <option value="">No published show days yet</option> : null}
            {targets.map((t) => (
              <option key={t.dateISO} value={t.dateISO}>
                {formatDate(t.dateISO, "long")}
                {t.loaded ? " — already loaded" : ""}
              </option>
            ))}
          </Select>
        </Field>

        {chosen ? (
          <p className="text-sm text-ink-muted">
            That day ran <strong className="text-ink">{chosen.expects}</strong>.
            {chosen.loaded
              ? " It already has a report — uploading again replaces it, leaving any box already packed alone."
              : ""}
          </p>
        ) : null}

        <input
          type="file"
          name="files"
          multiple
          accept=".csv,text/csv"
          required
          aria-label="The day's export files"
          className="block w-full cursor-pointer rounded-lg border border-line bg-canvas p-2.5 text-sm text-ink file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-brand-700"
        />
        <p className="text-xs text-ink-subtle">
          Which file is which is worked out from what is inside it, not from its name, and the
          TikTok exports are matched to their shows by the times the orders were placed. The day
          you choose above is checked against what the orders actually say — if they disagree,
          nothing is imported.
        </p>

        {state.error ? (
          <Alert tone="danger" title="Not imported">
            {state.error}
            {state.flags ? <Flags flags={state.flags} /> : null}
          </Alert>
        ) : null}

        {state.ok ? (
          <Alert tone="ok" title="Imported">
            {state.ok}
            {state.flags && state.flags.length > 0 ? <Flags flags={state.flags} /> : null}
          </Alert>
        ) : null}

        <UploadButton />
      </form>
    </Card>
  );
}

"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Alert, Button, Card, CardHeader } from "@/components/ui";
import { uploadReports } from "./actions";
import type { UploadState } from "./actions";

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

export function UploadForm() {
  const [state, action] = useActionState<UploadState, FormData>(uploadReports, {});
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      form.current?.reset();
      router.refresh();
    }
  }, [state.ok, router]);

  return (
    <Card>
      <CardHeader
        title="Upload a morning's reports"
        description="The two TikTok exports and the eBay one, for a single show day."
      />
      <form ref={form} action={action} className="space-y-3 p-4">
        <input
          type="file"
          name="files"
          multiple
          accept=".csv,text/csv"
          required
          aria-label="The morning's export files"
          className="block w-full cursor-pointer rounded-lg border border-line bg-canvas p-2.5 text-sm text-ink file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-brand-700"
        />
        <p className="text-xs text-ink-subtle">
          Which file is which is worked out from what is inside it, not from its name. The
          show day comes from the orders themselves — you do not pick a date.
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

"use client";

import { useActionState, useState } from "react";
import { Alert, Button } from "@/components/ui";
import { isMasterColumn, isMasterHeading, sheetRows } from "@/lib/domain/inventory-sheets";
import { uploadCount, uploadMasterRows } from "../actions";
import type { FormState } from "../actions";

function Result({ state }: { state: FormState }) {
  if (!state.error && !state.ok) return null;
  return (
    <Alert tone={state.error ? "danger" : "ok"}>
      {state.error ?? state.ok}
      {state.details && state.details.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {state.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

function UploadForm({
  action,
  label,
  button,
}: {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  label: string;
  button: string;
}) {
  const [state, run, pending] = useActionState<FormState, FormData>(action, {});
  return (
    <form action={run} className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
        <input
          type="file"
          name="file"
          accept=".xlsx"
          required
          className="block w-full cursor-pointer rounded-lg border border-line bg-canvas p-2 text-sm text-ink file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
        />
      </label>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Uploading…" : button}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function UploadCount() {
  return <UploadForm action={uploadCount} label="Upload a filled-in count sheet" button="Upload the count" />;
}

/**
 * Invicta's master file, read here in the browser.
 *
 * The real file is 24 MB, almost all of it pictures, and the site refuses
 * anything over a few MB. So the browser opens it and sends only the columns
 * the catalogue uses — a few hundred KB.
 */
export function UploadMaster() {
  const [state, setState] = useState<FormState>({});
  const [busy, setBusy] = useState(false);

  async function load(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = (e.currentTarget.elements.namedItem("file") as HTMLInputElement).files?.[0];
    if (!file) return setState({ error: "Choose the file first." });
    setBusy(true);
    setState({});
    try {
      let sheets;
      try {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await file.arrayBuffer());
        sheets = sheetRows(wb, isMasterHeading, isMasterColumn);
      } catch {
        setState({ error: "That file could not be opened. Is it the master file, saved as .xlsx?" });
        return;
      }
      try {
        setState(await uploadMasterRows(file.name, sheets));
      } catch {
        setState({ error: "The file was read, but sending it failed. Check the connection and try again; if it keeps failing, tell your admin." });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={load} className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">Upload Invicta&apos;s master file (.xlsx)</span>
        <input
          type="file"
          name="file"
          accept=".xlsx"
          required
          className="block w-full cursor-pointer rounded-lg border border-line bg-canvas p-2 text-sm text-ink file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
        />
      </label>
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? "Reading the file…" : "Load the master"}
      </Button>
      <Result state={state} />
    </form>
  );
}

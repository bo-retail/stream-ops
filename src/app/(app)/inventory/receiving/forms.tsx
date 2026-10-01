"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Input } from "@/components/ui";
import { sheetRows } from "@/lib/domain/inventory-sheets";
import { isOfferColumn, isOfferHeading, isShippingListHeading, offerDateFromName } from "@/lib/domain/receiving";
import { settle, uploadDetails, uploadOfferRows, uploadShipmentCount, uploadShippingListRows } from "./actions";
import type { ReceivingState } from "./actions";

export function Result({ state }: { state: ReceivingState }) {
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

const FILE_INPUT =
  "block w-full cursor-pointer rounded-lg border border-line bg-canvas p-2 text-sm text-ink file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white";

/** Open an .xlsx in the browser and keep only the rows (and columns) needed. */
async function readRows(file: File, isHeading: (c: string) => boolean, keep?: (h: string) => boolean) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  return sheetRows(wb, isHeading, keep);
}

/**
 * Daniel's offer. The date names it — read from the file name ("09.19 BO
 * retail offer") and shown, so it can be corrected before it is saved.
 */
export function UploadOffer({ today }: { today: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [date, setDate] = useState("");
  const [state, setState] = useState<ReceivingState>({});
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setState({ error: "Choose the offer first." });
    if (!date) return setState({ error: "Which day is this offer? Pick its date." });
    setBusy(true);
    setState({});
    try {
      let sheets;
      try {
        sheets = await readRows(file, isOfferHeading, isOfferColumn);
      } catch {
        return setState({ error: "That file could not be opened. Is it the offer, saved as .xlsx?" });
      }
      if (sheets.length === 0) return setState({ error: 'No sheet has a "Dani" column. Is this the offer?' });
      try {
        const r = await uploadOfferRows(file.name, date, sheets);
        setState(r);
        if (r.ok) router.refresh();
      } catch {
        setState({ error: "The file was read, but sending it failed. Check the connection and try again." });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">Daniel&apos;s offer (.xlsx)</span>
        <input
          type="file"
          accept=".xlsx"
          required
          className={FILE_INPUT}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setDate(f ? (offerDateFromName(f.name, today) ?? "") : "");
          }}
        />
      </label>
      {file ? (
        <label className="block w-48">
          <span className="mb-1.5 block text-sm font-medium text-ink">Offer date</span>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
      ) : null}
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? "Reading the offer…" : "Load the offer"}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function UploadShippingList() {
  const router = useRouter();
  const [state, setState] = useState<ReceivingState>({});
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = (e.currentTarget.elements.namedItem("file") as HTMLInputElement).files?.[0];
    if (!file) return setState({ error: "Choose the shipping list first." });
    setBusy(true);
    setState({});
    try {
      let sheets;
      try {
        sheets = await readRows(file, isShippingListHeading);
      } catch {
        return setState({ error: "That file could not be opened. Is it Invicta's shipping list, saved as .xlsx?" });
      }
      if (sheets.length === 0) return setState({ error: 'No sheet has an "SOP Number" column. Is this the shipping list?' });
      try {
        const r = await uploadShippingListRows(file.name, sheets);
        setState(r);
        if (r.ok) router.refresh();
      } catch {
        setState({ error: "The file was read, but sending it failed. Check the connection and try again." });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">Invicta&apos;s shipping list (.xlsx)</span>
        <input type="file" name="file" accept=".xlsx" required className={FILE_INPUT} />
      </label>
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? "Reading the list…" : "Load the shipping list"}
      </Button>
      <Result state={state} />
    </form>
  );
}

function UploadForm({ action, label, button }: { action: (prev: ReceivingState, data: FormData) => Promise<ReceivingState>; label: string; button: string }) {
  const [state, run, pending] = useActionState<ReceivingState, FormData>(action, {});
  return (
    <form action={run} className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
        <input type="file" name="file" accept=".xlsx" required className={FILE_INPUT} />
      </label>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Uploading…" : button}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function UploadShipmentCount({ sop }: { sop: string }) {
  return <UploadForm action={uploadShipmentCount.bind(null, sop)} label="Upload the filled-in count sheet" button="Upload the count" />;
}

export function UploadDetails() {
  return <UploadForm action={uploadDetails} label="Upload a filled-in product details sheet" button="Upload the details" />;
}

/** Mark a difference with Invicta settled, saying what settled it. */
export function SettleButton({ lineId }: { lineId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [state, setState] = useState<ReceivingState>({});
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Settle
      </Button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const r = await settle(lineId, note);
          setState(r);
          if (r.ok) router.refresh();
        } catch {
          setState({ error: "That did not save. Try again." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="How: credit, balance shipped, invoice fixed…" className="w-64" autoFocus />
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? "Saving…" : "Mark settled"}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {state.error ? <span className="text-sm text-danger-600">{state.error}</span> : null}
    </form>
  );
}

"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, PackageCheck, ScanLine, TriangleAlert, X } from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";
import { PLATFORM_SHORT } from "@/lib/domain/types";
import { addAnyway, closeBox, scanItem, scanLabel, startUnknownBox } from "./actions";
import type { PackingBoxView, ScanOutcome } from "@/lib/server/packing";

/**
 * The packing screen.
 *
 * One input, always focused. A barcode scanner is a keyboard that types and
 * presses Enter, so there is nothing to click between scans — she works with a
 * label in one hand and a watch in the other, and the screen keeps up.
 *
 * What the input means depends on whether a box is open: no box, it is a
 * shipping label; box open, it is a watch — unless it is plainly a label, which
 * the server answers as one and this screen offers to open (see `packItem`).
 */

type Tone = "ok" | "warn" | "danger" | "info";

interface Status {
  tone: Tone;
  text: string;
  /** Offered when a watch was refused because it is not on the list. */
  offerAdd?: string;
  /** A shipping label scanned while this box was open — offered as the next box to open. */
  switchLabel?: string;
}

const TONE_STYLES: Record<Tone, string> = {
  ok: "border-ok-200 bg-ok-50 text-ok-700",
  warn: "border-warn-200 bg-warn-50 text-warn-700",
  danger: "border-danger-200 bg-danger-50 text-danger-700",
  info: "border-brand-200 bg-brand-50 text-brand-700",
};

export function ScanClient() {
  const [box, setBox] = useState<PackingBoxView | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [unknownLabel, setUnknownLabel] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  const input = useRef<HTMLInputElement>(null);
  const focus = () => input.current?.focus();

  // The scanner types into whatever has focus. If anything ever steals it, the
  // next scan lands nowhere and the packer sees no response at all.
  useEffect(() => {
    if (!closing) focus();
  }, [box, closing, pending]);

  function apply(outcome: ScanOutcome) {
    switch (outcome.kind) {
      case "box":
        setBox(outcome.box);
        setUnknownLabel(null);
        setStatus(outcome.message ? { tone: "ok", text: outcome.message } : null);
        break;
      case "alreadyPacked":
        setBox(null);
        setUnknownLabel(null);
        setStatus({
          tone: "info",
          text: `Already packed${outcome.box.closedByName ? ` — by ${outcome.box.closedByName}` : ""}.`,
        });
        break;
      case "unknownLabel":
        setBox(null);
        setUnknownLabel(outcome.tracking);
        setStatus({ tone: "warn", text: "That label is not in any uploaded report." });
        break;
      case "refused":
        setBox(outcome.box);
        // The stock number comes off the outcome, not out of the sentence. This
        // used to match on the wording of the refusal, so rewording one would
        // have removed the only way to record a watch that really is in the box.
        //
        // A label or a misread is not a wrong watch: amber rather than red, and a
        // misread is never offered as something to add to the box.
        setStatus({
          tone: outcome.label || outcome.unreadable ? "warn" : "danger",
          text: outcome.message,
          offerAdd: outcome.unreadable || outcome.label ? undefined : outcome.stockNumber,
          switchLabel: outcome.label,
        });
        break;
      case "error":
        setStatus({ tone: "danger", text: outcome.message });
        break;
    }
  }

  function onScan(event: React.FormEvent) {
    event.preventDefault();
    const value = input.current?.value.trim() ?? "";
    if (value === "" || pending) return;
    if (input.current) input.current.value = "";

    startTransition(async () => {
      apply(box ? await scanItem(box.id, value) : await scanLabel(value));
    });
  }

  function run(fn: () => Promise<ScanOutcome>) {
    startTransition(async () => apply(await fn()));
  }

  // A box in no report expects nothing, so everything in it is "over" — the
  // server does not count that against it (see `sealBox`), and neither does this.
  const over = !box?.isUnrecognised && (box?.items.some((i) => i.scanned > i.expected) ?? false);
  const canCloseCleanly = (box?.complete ?? false) && !over;

  return (
    <div className="space-y-4">
      {/* --------------------------------------------------------- the input */}
      <Card className="p-4">
        <form onSubmit={onScan}>
          <label htmlFor="scan" className="mb-1.5 block text-sm font-medium text-ink">
            {box ? "Scan a watch" : "Scan a shipping label"}
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <ScanLine
                className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-subtle"
                aria-hidden
              />
              <input
                id="scan"
                ref={input}
                autoFocus
                autoComplete="off"
                disabled={pending}
                placeholder={box ? "watch barcode" : "shipping label"}
                className="tabular h-14 w-full rounded-lg border border-line-strong bg-surface pl-11 pr-3 text-lg text-ink placeholder:text-ink-subtle focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
              />
            </div>
            {box ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setBox(null);
                  setStatus(null);
                  focus();
                }}
              >
                Put down
              </Button>
            ) : null}
          </div>
        </form>

        {status ? (
          <div className={`mt-3 rounded-lg border px-3 py-2.5 text-sm font-medium ${TONE_STYLES[status.tone]}`}>
            <div className="flex items-start gap-2">
              {status.tone === "ok" ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              ) : status.tone === "danger" ? (
                <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              ) : (
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              )}
              <span>{status.text}</span>
            </div>
            {status.offerAdd && box ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-2"
                disabled={pending}
                onClick={() => run(() => addAnyway(box.id, status.offerAdd!))}
              >
                It really is in the box — add it anyway
              </Button>
            ) : null}
            {status.switchLabel && box ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {canCloseCleanly ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      const label = status.switchLabel!;
                      const boxId = box.id;
                      run(async () => {
                        const closed = await closeBox(boxId, false);
                        return closed.kind === "box" ? scanLabel(label) : closed;
                      });
                    }}
                  >
                    Close this box and open that one
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    const label = status.switchLabel!;
                    setBox(null);
                    run(() => scanLabel(label));
                  }}
                >
                  Put this box down and open that one
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {unknownLabel ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" disabled={pending} onClick={() => run(() => startUnknownBox(unknownLabel))}>
              Pack it anyway
            </Button>
            <span className="text-xs text-ink-muted">
              It will be recorded as whatever you scan into it, and listed for the director.
            </span>
          </div>
        ) : null}
      </Card>

      {/* ---------------------------------------------------------- the box */}
      {box ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <p className="tabular truncate text-sm font-semibold text-ink">{box.tracking}</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {box.isUnrecognised ? (
                  <Badge tone="warn">Not in any report</Badge>
                ) : (
                  <>
                    {PLATFORM_SHORT[box.platform]} · {box.buyer}
                    {box.shipToState ? ` · ${box.shipToState}` : ""}
                  </>
                )}
              </p>
            </div>
            <div className="text-right">
              <p className="tabular text-2xl font-semibold text-ink">
                {box.totalScanned}
                <span className="text-base font-normal text-ink-subtle"> of {box.totalExpected}</span>
              </p>
              <p className="text-xs text-ink-subtle">watches in the box</p>
            </div>
          </div>

          {box.items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-muted">
              Scan the watches as they go in.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {box.items.map((item) => {
                const done = item.outstanding === 0;
                const extra = item.scanned > item.expected;
                return (
                  <li
                    key={item.stockNumber}
                    className={`flex items-center justify-between gap-3 px-4 py-2.5 ${done && !extra ? "bg-ok-50/40" : ""}`}
                  >
                    <span className={`tabular text-sm font-medium ${done ? "text-ink-muted line-through" : "text-ink"}`}>
                      {item.stockNumber}
                    </span>
                    <span className="tabular shrink-0 text-sm">
                      {extra ? (
                        <span className="font-semibold text-warn-700">
                          {item.scanned} scanned · not on the report
                        </span>
                      ) : done ? (
                        <span className="font-semibold text-ok-700">{item.scanned} of {item.expected} ✓</span>
                      ) : (
                        <span className="font-semibold text-ink">
                          {item.scanned} of {item.expected}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="border-t border-line px-4 py-3">
            {box.status !== "OPEN" ? (
              <p className="text-sm font-medium text-ok-700">
                <PackageCheck className="mr-1.5 inline h-4 w-4" aria-hidden />
                Closed{box.closedByName ? ` by ${box.closedByName}` : ""}.
              </p>
            ) : closing ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-ink">
                  Close this box short? It will be recorded as incomplete, permanently.
                </p>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional — what happened? e.g. last one damaged"
                  className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="danger"
                    disabled={pending}
                    onClick={() => {
                      const boxId = box.id;
                      const reason = note;
                      setClosing(false);
                      setNote("");
                      run(() => closeBox(boxId, true, reason));
                    }}
                  >
                    Close incomplete
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => { setClosing(false); focus(); }}>
                    Keep packing
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  disabled={!canCloseCleanly || pending}
                  onClick={() => run(() => closeBox(box.id, false))}
                >
                  <PackageCheck className="h-4 w-4" aria-hidden />
                  Close box
                </Button>
                {/* Deliberately subordinate: available, but not the button you
                    reach for by accident. */}
                <button
                  type="button"
                  onClick={() => setClosing(true)}
                  className="text-sm font-medium text-ink-muted underline underline-offset-2 hover:text-ink"
                >
                  Close incomplete
                </button>
                {!canCloseCleanly ? (
                  <span className="text-xs text-ink-subtle">
                    {over
                      ? "Something was added that is not on the report."
                      : `${box.totalExpected - box.totalScanned} still to go in.`}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Download } from "lucide-react";
import { Alert, Button, Card, CardHeader, EmptyState, Input, Select, Table, Td, Th } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { EBAY_CAP, defaultSetPrice, marginAtTp, score, type PlanLine } from "@/lib/domain/show-plan";
import type { PlanRow } from "@/lib/server/show-plan";
import { releaseFileAction, savePlanAction, type PlanState } from "./actions";

type Choice = { AM: number; PM: number; setPrice: boolean };
type FileKey = "AM" | "PM" | "tiktok";
const FILES: { key: FileKey; href: string; label: string }[] = [
  { key: "AM", href: "ebay-am", label: "eBay AM file" },
  { key: "PM", href: "ebay-pm", label: "eBay PM file" },
  { key: "tiktok", href: "tiktok", label: "TikTok file (both shows)" },
];

const money = (cents: number | null) => (cents === null ? "—" : `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

export function DatePicker({ date }: { date: string }) {
  const router = useRouter();
  return (
    <Input
      type="date"
      value={date}
      onChange={(e) => e.target.value && router.push(`/inventory/plan?date=${e.target.value}`)}
      className="w-44"
      aria-label="Plan for"
    />
  );
}

/** A typed eBay number: blank is 0; anything else must be a whole number. */
function readCount(text: string): number {
  const t = text.trim();
  if (t === "") return 0;
  return /^\d+$/.test(t) ? Number(t) : NaN;
}

/**
 * The plan, model by model: AM and PM eBay typed in, TikTok worked out as
 * whatever is left, the set-price choice per model. Totals against eBay's 750
 * a show are kept live; the server checks everything again on save.
 */
export function PlanTable({
  date,
  rows,
  proposal,
  saved,
  current,
  files,
}: {
  date: string;
  rows: PlanRow[];
  proposal: Record<string, { AM: number; PM: number }>;
  saved: { version: number; savedAt: string; savedBy: string | null } | null;
  current: PlanLine[];
  /** The files already downloaded: their numbers are fixed. */
  files: Partial<Record<FileKey, { at: string; by: string | null }>>;
}) {
  const router = useRouter();
  const now = new Map(current.map((l) => [l.model, l]));
  // A file already downloaded keeps its numbers, whatever the suggestion says.
  // With the TikTok file out, eBay can only have what it did not take: the
  // suggestion is cut to that, PM first.
  const suggested = () =>
    Object.fromEntries(
      rows.map((r) => {
        const n = now.get(r.model);
        let AM = files.AM ? (n?.AM ?? 0) : (proposal[r.model]?.AM ?? 0);
        let PM = files.PM ? (n?.PM ?? 0) : (proposal[r.model]?.PM ?? 0);
        if (files.tiktok) {
          const room = Math.max(0, r.available - (n?.tiktok ?? 0) - (files.AM ? AM : 0) - (files.PM ? PM : 0));
          let over = (files.AM ? 0 : AM) + (files.PM ? 0 : PM) - room;
          if (over > 0 && !files.PM) {
            const cut = Math.min(PM, over);
            PM -= cut;
            over -= cut;
          }
          if (over > 0 && !files.AM) AM -= Math.min(AM, over);
        }
        return [r.model, { AM, PM, setPrice: defaultSetPrice(r.tpCents) }];
      }),
    );
  const fromSaved = () => Object.fromEntries(current.map((l) => [l.model, { AM: l.AM, PM: l.PM, setPrice: l.setPrice }]));
  const [choices, setChoices] = useState<Record<string, Choice>>(() => (saved ? fromSaved() : suggested()));
  // What is typed, as typed, so a half-typed number is not snapped back.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [dirty, setDirty] = useState(!saved);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<PlanState>({});
  // The version this screen last saved, so a second save does not look like somebody else's.
  const [version, setVersion] = useState<number | null>(saved?.version ?? null);
  const tiktokOut = new Map(current.map((l) => [l.model, l.tiktok]));

  // A file downloaded since this screen opened (here or by someone else): its
  // numbers are now fixed, so the screen takes them from the server.
  const fixedKey = JSON.stringify([files.AM?.at, files.PM?.at, current.map((l) => [l.model, l.AM, l.PM])]);
  useEffect(() => {
    if (!files.AM && !files.PM) return;
    setChoices((all) => {
      const next = { ...all };
      for (const l of current) {
        const c = next[l.model] ?? { AM: 0, PM: 0, setPrice: l.setPrice };
        next[l.model] = { ...c, AM: files.AM ? l.AM : c.AM, PM: files.PM ? l.PM : c.PM };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedKey]);

  const ordered = useMemo(() => [...rows].sort((a, b) => score(b) - score(a) || a.model.localeCompare(b.model)), [rows]);
  const shown = filter.trim()
    ? ordered.filter((r) => `${r.model} ${r.description}`.toLowerCase().includes(filter.trim().toLowerCase()))
    : ordered;

  // The same rule the server checks: a file already downloaded keeps its
  // numbers; only the units not in one must fit what is left of the shelf.
  const stateOf = (r: PlanRow, c: Choice) => {
    const bad = !Number.isFinite(c.AM) || !Number.isFinite(c.PM);
    const fixed = (files.AM ? c.AM : 0) + (files.PM ? c.PM : 0) + (files.tiktok ? (tiktokOut.get(r.model) ?? 0) : 0);
    const room = Math.max(0, r.available - fixed);
    const free = (files.AM ? 0 : c.AM) + (files.PM ? 0 : c.PM);
    const tooMany = !bad && free > room;
    const notReady = !bad && free > 0 && r.missingEbay.length > 0;
    return { bad, tooMany, notReady, left: room - free };
  };

  const totals = { AM: 0, PM: 0, tiktok: 0, bad: 0 };
  for (const r of rows) {
    const c = choices[r.model] ?? { AM: 0, PM: 0, setPrice: false };
    const st = stateOf(r, c);
    totals.AM += Number.isFinite(c.AM) ? c.AM : 0;
    totals.PM += Number.isFinite(c.PM) ? c.PM : 0;
    if (st.bad || st.tooMany || st.notReady) totals.bad++;
    else if (files.tiktok) totals.tiktok += tiktokOut.get(r.model) ?? 0;
    else if (r.missingTiktok.length === 0) totals.tiktok += st.left;
  }

  function set(model: string, field: "AM" | "PM", text: string) {
    setTyped((t) => ({ ...t, [`${model}|${field}`]: text }));
    setChoices((all) => ({ ...all, [model]: { ...(all[model] ?? { AM: 0, PM: 0, setPrice: false }), [field]: readCount(text) } }));
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setState({});
    try {
      const list = rows.map((r) => ({ model: r.model, ...(choices[r.model] ?? { AM: 0, PM: 0, setPrice: false }) }));
      const r = await savePlanAction(date, version, list);
      setState(r);
      if (r.ok) {
        if (r.version !== undefined) setVersion(r.version);
        setDirty(false);
        setTyped({});
        router.refresh();
      }
    } catch {
      setState({ error: "That did not save. Check the connection and try again; nothing was half-saved." });
    } finally {
      setBusy(false);
    }
  }

  const over = (n: number) => (n > EBAY_CAP ? "text-danger-700 font-semibold" : "");
  const canDownload = saved !== null && !dirty;

  return (
    <Card>
      <CardHeader
        title="eBay and TikTok"
        description={
          saved
            ? `Saved ${new Date(saved.savedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}${saved.savedBy ? ` by ${saved.savedBy}` : ""}.`
            : "Not saved yet: these are the suggested numbers (best margin × best sellers, at most half a model's units on eBay, split between the two shows)."
        }
      />
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-white px-4 py-3 text-sm">
        <span>AM eBay <b className={over(totals.AM)}>{totals.AM}</b> / {EBAY_CAP}</span>
        <span>PM eBay <b className={over(totals.PM)}>{totals.PM}</b> / {EBAY_CAP}</span>
        <span>TikTok <b>{totals.tiktok}</b></span>
        {totals.bad > 0 ? <span className="font-semibold text-danger-700">{totals.bad} row{totals.bad > 1 ? "s" : ""} to fix</span> : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setChoices(suggested());
              setTyped({});
              setDirty(true);
            }}
          >
            Use the suggestion
          </Button>
          <Button size="sm" onClick={save} disabled={busy || rows.length === 0}>
            {busy ? "Saving…" : "Save the plan"}
          </Button>
        </div>
      </div>

      <div className="space-y-3 p-4">
        {state.error || state.ok ? (
          <Alert tone={state.error ? "danger" : "ok"}>
            {state.error ?? state.ok}
            {state.problems && state.problems.length > 0 ? (
              <ul className="mt-2 list-disc space-y-0.5 pl-5">
                {state.problems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            ) : null}
          </Alert>
        ) : null}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {FILES.map((f) =>
              canDownload ? (
                <a
                  key={f.key}
                  href={`/api/inventory/plan/${date}/${f.href}`}
                  onClick={() => {
                    // The download can take a few seconds; look again twice.
                    setTimeout(() => router.refresh(), 2000);
                    setTimeout(() => router.refresh(), 8000);
                  }}
                  className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-ink hover:bg-canvas"
                >
                  <Download className="h-4 w-4" aria-hidden /> {f.label}
                </a>
              ) : (
                <span key={f.key} className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink-subtle">
                  <Download className="h-4 w-4" aria-hidden /> {f.label}
                </span>
              ),
            )}
            {!canDownload ? <span className="text-sm text-ink-muted">Save the plan to download the files.</span> : null}
          </div>
          {FILES.filter((f) => files[f.key]).map((f) => (
            <p key={f.key} className="text-sm text-ink-muted">
              {f.label} downloaded {new Date(files[f.key]!.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
              {files[f.key]!.by ? ` by ${files[f.key]!.by}` : ""}: its numbers are fixed, and downloading it again gives the same file.{" "}
              <button
                type="button"
                className="underline"
                onClick={async () => {
                  if (!window.confirm(`Only if the ${f.label} was NOT uploaded: free it so its numbers can change?`)) return;
                  setState(await releaseFileAction(date, f.key));
                  router.refresh();
                }}
              >
                It was not uploaded
              </button>
            </p>
          ))}
        </div>

        <Input placeholder="Find a model" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Nothing on the shelf">No model has sellable stock, so there is nothing to plan.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-14" />
              <Th>Model</Th>
              <Th className="text-right">Shelf</Th>
              <Th className="text-right">TP</Th>
              <Th className="text-right">Margin</Th>
              <Th className="text-right">Sold, 7 days</Th>
              <Th className="text-right">AM eBay</Th>
              <Th className="text-right">PM eBay</Th>
              <Th className="text-right">TikTok</Th>
              <Th>Runs at</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const c = choices[r.model] ?? { AM: 0, PM: 0, setPrice: false };
              const { bad, tooMany, left } = stateOf(r, c);
              const noEbay = r.missingEbay.length > 0;
              const m = marginAtTp(r);
              return (
                <tr key={r.model} className={bad || tooMany ? "bg-danger-50" : undefined}>
                  <Td><WatchImage url={r.picture} model={r.model} size={40} /></Td>
                  <Td>
                    <Link href={`/inventory/${encodeURIComponent(r.model)}`} className="font-mono underline">{r.model}</Link>
                    <div className="max-w-xs truncate text-xs text-ink-muted">{r.description}</div>
                    {tooMany ? <div className="text-xs text-danger-700">More on eBay than is left on the shelf.</div> : null}
                  </Td>
                  <Td className="text-right tabular-nums">{r.available}</Td>
                  <Td className="text-right tabular-nums">{money(r.tpCents)}</Td>
                  <Td className="text-right tabular-nums">{m === null ? "—" : `${Math.round(m * 100)}%`}</Td>
                  <Td className="text-right tabular-nums">{r.soldLast7}</Td>
                  {(["AM", "PM"] as const).map((show) => (
                    <Td key={show} className="text-right">
                      {files[show] ? (
                        <span className="tabular-nums" title="This file is already downloaded">{c[show]}</span>
                      ) : noEbay ? (
                        <span className="text-xs text-ink-subtle" title={`Needs its ${r.missingEbay.join(", ")}`}>not ready</span>
                      ) : (
                        <Input
                          inputMode="numeric"
                          aria-label={`${show} eBay units of ${r.model}`}
                          className="w-16 text-right"
                          value={typed[`${r.model}|${show}`] ?? String(c[show])}
                          onChange={(e) => set(r.model, show, e.target.value)}
                        />
                      )}
                    </Td>
                  ))}
                  <Td className="text-right tabular-nums">
                    {files.tiktok ? (
                      <span title="The TikTok file is already downloaded">{tiktokOut.get(r.model) ?? 0}</span>
                    ) : r.missingTiktok.length > 0 ? (
                      <span className="text-xs text-ink-subtle" title={`Needs its ${r.missingTiktok.join(", ")}`}>not ready</span>
                    ) : bad || tooMany ? (
                      "—"
                    ) : (
                      left
                    )}
                  </Td>
                  <Td>
                    <Select
                      aria-label={`What ${r.model} runs at`}
                      value={c.setPrice ? "set" : "one"}
                      onChange={(e) => {
                        setChoices((all) => ({ ...all, [r.model]: { ...c, setPrice: e.target.value === "set" } }));
                        setDirty(true);
                      }}
                    >
                      <option value="one">$1 start</option>
                      <option value="set" disabled={!r.tpCents}>Set price {money(r.tpCents)}</option>
                    </Select>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

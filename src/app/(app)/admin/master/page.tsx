import type { Metadata } from "next";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { requireBoss } from "@/lib/auth/guards";
import { dateTimeFormatter } from "@/lib/domain/dates";
import { formatMoney } from "@/lib/domain/insights";
import { masterGaps, masterUploadLog } from "@/lib/server/inventory";
import { getSettings } from "@/lib/server/settings";
import { UploadMaster } from "../../inventory/templates/upload-forms";
import { formatCount } from "@/lib/domain/insights";

export const metadata: Metadata = { title: "Invicta master" };

/**
 * The Invicta master: where it is loaded, and every upload, newest first, with
 * what each one changed. Admins only — the master sets cost, and cost is for
 * admins only (Samuel, 21 October).
 *
 * The newest master's cost is each model's cost, so this is where a cost change
 * is traced back to the file that made it — old and new, model by model. Each
 * sale keeps the cost it had the day it sold, so nothing here rewrites the past.
 */
export default async function InvictaMasterPage() {
  await requireBoss();
  const { timezone } = await getSettings();
  const when = dateTimeFormatter(timezone);
  const [log, gaps] = await Promise.all([masterUploadLog(), masterGaps()]);
  const missing = (what: "Description" | "Cost" | "Picture") => gaps.filter((g) => g.missing.includes(what)).length;
  const inStock = gaps.filter((g) => g.pieces > 0).length;

  return (
    <>
      <PageHeader
        title="Invicta master"
        description="Load Invicta's master file: it adds new models, updates descriptions and pictures, and its cost becomes each model's cost. A sale keeps the cost it had the day it sold."
      />
      <div className="max-w-3xl space-y-5">
        <Card>
          <CardHeader
            title="Upload the master"
            description="Their file, as it comes (.xlsx). Never deletes a model; a blank or $0 cost changes nothing. Only admins see this page."
          />
          <div className="p-4">
            <UploadMaster />
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Missing from the master"
            description="Models in the app the master has not given a description, a cost or a picture — the list to send Daniel. Models in stock come first."
          />
          <div className="space-y-3 p-4 text-sm">
            {gaps.length === 0 ? (
              <p className="text-ok-700">Every model has a description, a cost and a picture.</p>
            ) : (
              <>
                <p className="text-ink">
                  <span className="font-semibold">{gaps.length.toLocaleString("en-US")} model(s)</span> are missing something
                  {inStock > 0 ? `, ${inStock.toLocaleString("en-US")} of them in stock` : ""}: {missing("Description")} without a
                  description, {missing("Cost")} without a cost, {missing("Picture")} without a picture.
                </p>
                <a
                  href="/api/inventory/master-gaps"
                  className="inline-flex items-center rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
                >
                  Download the list (Excel)
                </a>
              </>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="History" description="Open one to see what it added and every cost it changed, old and new." />
          {log.length === 0 ? (
            <p className="p-4 text-sm text-ink-muted">No master loaded yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {log.map((u) => {
                const r = u.record;
                return (
                  <li key={u.id}>
                    <details>
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 hover:bg-canvas [&::-webkit-details-marker]:hidden">
                        <div className="min-w-0 text-sm">
                          <p className="truncate font-medium text-ink">{r?.fileName ?? "Master file"}</p>
                          <p className="text-xs text-ink-muted">
                            {when(u.at)}
                            {u.by ? ` by ${u.by}` : ""}
                            {r
                              ? ` · ${formatCount(r.models)} model(s) · ${formatCount(r.added.length)} added · ${formatCount(r.costsChanged.length)} cost(s) changed · ${formatCount(r.costsFilled.length)} filled`
                              : ""}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs text-brand-700">Details</span>
                      </summary>
                      <div className="space-y-4 border-t border-line bg-canvas/50 px-4 py-3 text-sm">
                        {!r ? (
                          <p className="text-ink-muted">{u.summary} (Loaded before uploads were recorded in full.)</p>
                        ) : (
                          <>
                            <section>
                              <h3 className="mb-1 text-[13px] font-semibold text-ink-muted">
                                Costs changed ({r.costsChanged.length})
                              </h3>
                              {r.costsChanged.length === 0 ? (
                                <p className="text-ink-muted">None — every cost already matched.</p>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="w-full min-w-[22rem]">
                                    <thead>
                                      <tr className="text-left text-[12.5px] font-semibold text-ink-muted">
                                        <th className="py-1 font-semibold">Model</th>
                                        <th className="py-1 text-right font-semibold">Was</th>
                                        <th className="py-1 text-right font-semibold">Now</th>
                                        <th className="py-1 text-right font-semibold">Change</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {r.costsChanged.map((c) => (
                                        <tr key={c.model} className="border-t border-line">
                                          <td className="py-1 tabular">{c.model}</td>
                                          <td className="py-1 text-right tabular text-ink-muted">{formatMoney(c.from)}</td>
                                          <td className="py-1 text-right font-semibold tabular">{formatMoney(c.to)}</td>
                                          <td
                                            className={`py-1 text-right tabular ${c.to > c.from ? "text-danger-600" : "text-ok-700"}`}
                                          >
                                            {c.to > c.from ? "+" : "−"}
                                            {formatMoney(Math.abs(c.to - c.from))}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </section>
                            {r.costsFilled.length > 0 ? (
                              <section>
                                <h3 className="mb-1 text-[13px] font-semibold text-ink-muted">
                                  Costs filled in where there was none ({r.costsFilled.length})
                                </h3>
                                <p className="tabular text-ink-muted">
                                  {r.costsFilled.map((c) => `${c.model} ${formatMoney(c.to)}`).join(" · ")}
                                </p>
                              </section>
                            ) : null}
                            {r.added.length > 0 ? (
                              <section>
                                <h3 className="mb-1 text-[13px] font-semibold text-ink-muted">
                                  New models ({r.added.length})
                                </h3>
                                <p className="tabular text-ink-muted">{r.added.join(" · ")}</p>
                              </section>
                            ) : null}
                            {r.skipped.length > 0 ? (
                              <section>
                                <h3 className="mb-1 text-[13px] font-semibold text-ink-muted">
                                  Rows skipped ({r.skipped.length})
                                </h3>
                                <ul className="list-disc pl-5 text-ink-muted">
                                  {r.skipped.map((s) => (
                                    <li key={s}>{s}</li>
                                  ))}
                                </ul>
                              </section>
                            ) : null}
                            <p className="text-xs text-ink-subtle">
                              {formatCount(r.updated)} model(s) updated, {formatCount(r.unchanged)} unchanged
                              {r.flagged > 0 ? ` · ${r.flagged} still need a description` : ""}.
                            </p>
                          </>
                        )}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

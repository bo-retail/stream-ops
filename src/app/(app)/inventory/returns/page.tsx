import type { Metadata } from "next";
import { Card, CardHeader, LinkButton, PageHeader } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { formatDate, todayISO } from "@/lib/domain/dates";
import { COUNTED_LABEL, COUNTED_PLACES } from "@/lib/domain/inventory";
import { returnLog } from "@/lib/server/returns";
import { getSettings } from "@/lib/server/settings";
import { ReturnsForm, UndoReturns } from "./returns-form";
import { formatCount } from "@/lib/domain/insights";

export const metadata: Metadata = { title: "Returns" };

/** Returns: download the sheet, fill in what came back, upload it. Placed as a delivery is; a model never in inventory where the page is told. */
export default async function ReturnsPage() {
  await requireShippingDirector();
  const { timezone } = await getSettings();
  const today = todayISO(timezone);
  const log = await returnLog();
  return (
    <>
      <PageHeader
        title="Returns"
        description="Watches that came back are added back to inventory, ready to sell again."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />
      <div className="max-w-3xl space-y-5">
        <Card>
          <CardHeader
            title="1. Download the sheet"
            description="Just Model and Quantity: how many of each model came back. The app places them the same way as a delivery: a missing TikTok or eBay sample is filled first, 1 or 2 of a model missing its samples go to Random pulls, the rest to Sellable. A model never in inventory: you are asked where it goes. Only enter watches that can be sold again — a damaged one is not put back. An order cancelled before it shipped is not a return: it comes back on its own when the corrected sales report is uploaded."
          />
          <div className="p-4">
            <a
              href="/api/inventory/returns-sheet"
              className="inline-flex items-center rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              Download the returns sheet
            </a>
          </div>
        </Card>
        <Card>
          <CardHeader
            title="2. Upload it"
            description="A model at zero is fine. A model never in inventory opens a box asking where it goes — check its number against the watch first. If the upload asks something (the same returns again, or already counted), read it first. Nothing is added if any row cannot be read."
          />
          <div className="p-4">
            <ReturnsForm today={today} />
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Returns log"
            description="Every returns upload, newest first. Added with wrong numbers? Undo it, then upload the corrected sheet."
          />
          {log.length === 0 ? (
            <p className="p-4 text-sm text-ink-muted">No returns yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {log.map((r) => (
                <li key={r.entryId} className={r.undone ? "opacity-60" : undefined}>
                  <details>
                    <summary className="flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden justify-between gap-3 px-4 py-2.5 hover:bg-canvas">
                      <div className="min-w-0 text-sm">
                        <p className="truncate font-medium text-ink">
                          {r.name}
                          {r.undone ? <span className="ml-2 text-xs font-semibold uppercase text-danger-700">Undone</span> : null}
                        </p>
                        <p className="text-xs text-ink-muted">
                          Came back {formatDate(r.returnedOn)} · {formatCount(r.pieces)} piece(s), {formatCount(r.items.length)} model(s) · uploaded{" "}
                          {r.at.toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          {r.by ? ` by ${r.by}` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-brand-700">Details</span>
                    </summary>
                    <div className="border-t border-line bg-canvas/50 px-4 py-3">
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[28rem] text-sm">
                          <thead>
                            <tr className="text-left text-[12.5px] font-semibold text-ink-muted">
                              <th className="py-1 font-semibold">Model</th>
                              {COUNTED_PLACES.map((p) => (
                                <th key={p} className="py-1 text-right font-semibold">
                                  {COUNTED_LABEL[p]}
                                </th>
                              ))}
                              <th className="py-1 text-right font-semibold">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.items.map((i) => (
                              <tr key={i.model} className="border-t border-line">
                                <td className="py-1 tabular">{i.model}</td>
                                {COUNTED_PLACES.map((p) => (
                                  <td key={p} className="py-1 text-right tabular">
                                    {i.placed[p] || <span className="text-ink-subtle">—</span>}
                                  </td>
                                ))}
                                <td className="py-1 text-right font-semibold tabular">{formatCount(i.total)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {r.undone ? null : (
                        <div className="mt-3">
                          <UndoReturns entryId={r.entryId} label={r.name} />
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

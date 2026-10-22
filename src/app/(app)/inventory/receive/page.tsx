import type { Metadata } from "next";
import { Card, CardHeader, LinkButton, PageHeader } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { formatDate, todayISO } from "@/lib/domain/dates";
import { COUNTED_LABEL, COUNTED_PLACES } from "@/lib/domain/inventory";
import { deliveryLog } from "@/lib/server/receive";
import { getSettings } from "@/lib/server/settings";
import { ReceiveForm, UndoDelivery } from "./receive-form";
import { formatCount } from "@/lib/domain/insights";

export const metadata: Metadata = { title: "Receive inventory" };

/** Receiving: download the sheet, fill in what arrived, upload it. It is added to stock. */
export default async function ReceivePage() {
  await requireShippingDirector();
  const { timezone } = await getSettings();
  const today = todayISO(timezone);
  const log = await deliveryLog();
  return (
    <>
      <PageHeader
        title="Receive inventory"
        description="What arrived is added to what is already in stock."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />
      <div className="max-w-3xl space-y-5">
        <Card>
          <CardHeader
            title="1. Download the sheet"
            description="Just Model and Quantity: count how many of each model arrived. The app puts them where they belong: a model that already has its TikTok and eBay samples goes all to Sellable; one missing a sample gets it first and the rest goes to Sellable — unless only 1 or 2 arrived, which go to Random pulls. A model not in inventory yet is added."
          />
          <div className="p-4">
            <a
              href="/api/inventory/receiving-sheet"
              className="inline-flex items-center rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              Download the receiving sheet
            </a>
          </div>
        </Card>
        <Card>
          <CardHeader
            title="2. Upload it"
            description="A delivery already added, the same models and quantities within a week, is refused unless you say it really is another one, so nothing is counted twice by mistake. Nothing is added if any row cannot be read."
          />
          <div className="p-4">
            <ReceiveForm today={today} />
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Delivery log"
            description="Every delivery received, newest first. Open one to see what was in it and where it went. Added with wrong numbers? Delete it, then upload the corrected sheet."
          />
          {log.length === 0 ? (
            <p className="p-4 text-sm text-ink-muted">Nothing received yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {log.map((d) => (
                <li key={d.entryId} className={`flex flex-wrap items-start ${d.undone ? "opacity-60" : ""}`}>
                  <details className="min-w-0 flex-1">
                    <summary className="flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden justify-between gap-3 px-4 py-2.5 hover:bg-canvas">
                      <div className="min-w-0 text-sm">
                        <p className="truncate font-medium text-ink">
                          {d.name}
                          {d.undone ? <span className="ml-2 text-xs font-semibold uppercase text-danger-700">Deleted</span> : null}
                        </p>
                        <p className="text-xs text-ink-muted">
                          Received {formatDate(d.receivedOn)} · {formatCount(d.pieces)} piece(s), {formatCount(d.models)} model(s) · uploaded{" "}
                          {d.at.toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          {d.by ? ` by ${d.by}` : ""}
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
                          {d.items.map((i) => (
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
                    </div>
                  </details>
                  <UndoDelivery entryId={d.entryId} label={d.name} deleted={d.undone} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

import type { Metadata } from "next";
import { Card, CardHeader, LinkButton, PageHeader } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { formatDate, todayISO } from "@/lib/domain/dates";
import { returnLog } from "@/lib/server/returns";
import { getSettings } from "@/lib/server/settings";
import { ReturnsForm, UndoReturns } from "./returns-form";

export const metadata: Metadata = { title: "Returns" };

/** Returns: download the sheet, fill in what came back, upload it. It all goes back to Sellable. */
export default async function ReturnsPage() {
  await requireShippingDirector();
  const { timezone } = await getSettings();
  const today = todayISO(timezone);
  const log = await returnLog();
  return (
    <>
      <PageHeader
        title="Returns"
        description="Watches that came back are added to Sellable, ready to sell again."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />
      <div className="max-w-3xl space-y-5">
        <Card>
          <CardHeader
            title="1. Download the sheet"
            description="Just Model and Quantity: how many of each model came back. Only enter watches that can be sold again — a damaged one is not put back. An order cancelled before it shipped is not a return: it comes back on its own when the corrected sales report is uploaded."
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
            description="Every model must already be in inventory. The same returns uploaded twice on one day are refused unless you say they really are other watches. Nothing is added if any row cannot be read."
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
                          Came back {formatDate(r.returnedOn)} · {r.pieces} piece(s), {r.items.length} model(s) · uploaded{" "}
                          {r.at.toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          {r.by ? ` by ${r.by}` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-brand-700">Details</span>
                    </summary>
                    <div className="border-t border-line bg-canvas/50 px-4 py-3">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs uppercase text-ink-subtle">
                            <th className="py-1 font-semibold">Model</th>
                            <th className="py-1 text-right font-semibold">Back to Sellable</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.items.map((i) => (
                            <tr key={i.model} className="border-t border-line">
                              <td className="py-1 tabular">{i.model}</td>
                              <td className="py-1 text-right font-semibold tabular">{i.qty}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
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

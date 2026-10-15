import type { Metadata } from "next";
import { Card, CardHeader, LinkButton, PageHeader } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { todayISO } from "@/lib/domain/dates";
import { recentReceipts } from "@/lib/server/receive";
import { getSettings } from "@/lib/server/settings";
import { ReceiveForm, UndoDelivery } from "./receive-form";

export const metadata: Metadata = { title: "Receive inventory" };

/** Receiving: download the sheet, fill in what arrived, upload it. It is added to stock. */
export default async function ReceivePage() {
  await requireShippingDirector();
  const { timezone } = await getSettings();
  const today = todayISO(timezone);
  const recent = await recentReceipts();
  return (
    <>
      <PageHeader
        title="Receive inventory"
        description="What arrived is added to what is already in stock."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />
      <div className="max-w-2xl space-y-5">
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
            title="Recent deliveries"
            description="Added with wrong numbers? Undo it, then upload the corrected sheet. Undo takes exactly that delivery back off stock."
          />
          {recent.length === 0 ? (
            <p className="p-4 text-sm text-ink-muted">Nothing received yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {recent.map((r) => (
                <li key={r.entryId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0 text-sm">
                    <p className="truncate font-medium text-ink">{r.note.replace(/^Received /, "")}</p>
                    <p className="text-xs text-ink-muted">
                      {r.pieces} piece(s), {r.models} model(s) · added {r.at.toLocaleString("en-US", { timeZone: timezone })}
                      {r.by ? ` by ${r.by}` : ""}
                    </p>
                  </div>
                  <UndoDelivery entryId={r.entryId} label={r.note.replace(/^Received /, "")} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

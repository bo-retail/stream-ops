import type { Metadata } from "next";
import { Card, CardHeader, LinkButton, PageHeader } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { todayISO } from "@/lib/domain/dates";
import { getSettings } from "@/lib/server/settings";
import { StartForm } from "./start-form";

export const metadata: Metadata = { title: "Starting count" };

/**
 * The starting count: download the sheet, count, upload it. Inventory starts
 * again from what the sheet says.
 */
export default async function StartingCountPage() {
  await requireShippingDirector();
  const today = todayISO((await getSettings()).timezone);
  return (
    <>
      <PageHeader
        title="Starting count"
        description="Count everything once; from then on the sales report subtracts."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />
      <div className="max-w-2xl space-y-5">
        <Card>
          <CardHeader
            title="1. Download the sheet"
            description="Every model, with four columns to fill in: Sellable, TT sample, eBay sample, Random pulls. Blank means none. A watch not on the list goes at the bottom with its model number."
          />
          <div className="p-4">
            <a
              href="/api/inventory/starting-count-sheet"
              className="inline-flex items-center rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              Download the count sheet
            </a>
          </div>
        </Card>
        <Card>
          <CardHeader title="2. Upload it" description="Nothing is saved if any row can't be read — you'll see which rows to fix." />
          <div className="p-4">
            <StartForm today={today} />
          </div>
        </Card>
      </div>
    </>
  );
}

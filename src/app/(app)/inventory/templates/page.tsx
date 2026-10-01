import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { Card, CardHeader, LinkButton, PageHeader } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { UploadDetails } from "../receiving/forms";
import { UploadCount, UploadMaster } from "./upload-forms";

export const metadata: Metadata = { title: "Templates & uploads" };

/**
 * Every inventory template, and where each one goes back in.
 *
 * The templates live here rather than in a shared folder, so the copy
 * downloaded is always the current one. Each job can also be done on its own
 * screen without any file at all — the template is for whoever prefers it.
 */
export default async function TemplatesPage() {
  await requireShippingDirector();

  return (
    <>
      <PageHeader
        title="Templates & uploads"
        description="Download a template, fill it in, upload it. Every job here can also be typed straight into the app instead."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Count sheet"
            description="Every model, with a column for each place. Blank means not counted; 0 means none. The second tab is for watches that are not on the list."
          />
          <div className="space-y-4 p-4">
            <a
              href="/api/inventory/count-sheet"
              className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-ink hover:bg-canvas"
            >
              <Download className="h-4 w-4" aria-hidden /> Download the count sheet
            </a>
            <p className="text-sm text-ink-muted">
              Or count on the <Link href="/inventory/count" className="underline">count screen</Link>, one model at a time.
            </p>
            <UploadCount />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Product details"
            description="Everything about a model the offer does not say: description, target price, TikTok weight and box, eBay profile, barcode. Models still needing theirs are at the top. A blank keeps what is there; cost only fills a missing one."
          />
          <div className="space-y-4 p-4">
            <a
              href="/api/inventory/details-sheet"
              className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-ink hover:bg-canvas"
            >
              <Download className="h-4 w-4" aria-hidden /> Download the product details sheet
            </a>
            <p className="text-sm text-ink-muted">Or fill them in on each model&apos;s page, with its picture.</p>
            <UploadDetails />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Shipment count"
            description="Each shipment has its own count sheet, with its list filled in."
          />
          <div className="p-4 text-sm text-ink-muted">
            Open the shipment on <Link href="/inventory/receiving" className="underline">Receiving</Link>: count it there, or download its sheet and upload it back on the same page.
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Invicta master file"
            description="Their file, as it comes. Adds new models and updates details; never deletes a model, and never changes a cost that is already set."
          />
          <div className="p-4">
            <UploadMaster />
          </div>
        </Card>
      </div>
    </>
  );
}

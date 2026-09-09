import type { Metadata } from "next";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { requireShipping } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Packing" };

/**
 * The packing screen: scan the label, scan each watch in, close the box.
 *
 * Open to the shipping team, the director and the boss. A streamer has no boxes
 * and is sent back to their dashboard.
 *
 * Waiting on the shipping tables, so nothing is queried here yet.
 */
export default async function PackingPage() {
  await requireShipping();

  return (
    <>
      <PageHeader
        title="Packing"
        description="Scan a shipping label to open its box."
      />
      <Card>
        <CardHeader
          title="Not yet connected"
          description="Waiting on the shipping tables."
        />
        <EmptyState title="The scanner is not wired up yet">
          Scanning a label will open the box and list what belongs in it, one line per
          stock number with a count. Each watch is scanned in as it goes in the box, and
          the box closes only when every count is met.
        </EmptyState>
      </Card>
    </>
  );
}

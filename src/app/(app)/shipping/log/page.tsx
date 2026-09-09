import type { Metadata } from "next";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Shipping log" };

/**
 * The day's counters, who packed what, and the permanent scan record.
 *
 * Opens on yesterday rather than today: yesterday's shows are packed this
 * morning, so the day that matters when this is opened is almost always the one
 * before.
 *
 * Deliberately not open to packers — the box in front of them is their screen.
 *
 * Waiting on the shipping tables, so nothing is queried here yet.
 */
export default async function ShippingLogPage() {
  await requireShippingDirector();

  return (
    <>
      <PageHeader
        title="Shipping log"
        description="Boxes sent, who sent them, and every scan that went into them."
      />
      <Card>
        <CardHeader
          title="Not yet connected"
          description="Waiting on the shipping tables."
        />
        <EmptyState title="No scan history yet">
          This will show how many boxes a day needed and how many went out, broken down by
          person, with the incomplete boxes and unrecognised labels listed underneath. Any
          past date can be pulled up — the scan record is kept permanently.
        </EmptyState>
      </Card>
    </>
  );
}

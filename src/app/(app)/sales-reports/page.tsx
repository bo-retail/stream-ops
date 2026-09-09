import type { Metadata } from "next";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Sales report entry" };

/**
 * Where the morning's three exports come in.
 *
 * The only door data enters the system through: the day's boxes, the sales
 * records behind them and the commission figures all come from here.
 *
 * The parsing this page will call is already written and tested — see
 * `src/lib/domain/imports`. What is still missing is the schema it writes to;
 * the page deliberately queries none of the new tables until that migration has
 * run, so it renders rather than failing.
 */
export default async function SalesReportsPage() {
  await requireShippingDirector();

  return (
    <>
      <PageHeader
        title="Sales report entry"
        description="Drop in the morning's TikTok and eBay exports for each show day."
      />
      <Card>
        <CardHeader
          title="Not yet connected"
          description="The file reading is built and tested; it is waiting on the database change."
        />
        <EmptyState title="Waiting on the shipping tables">
          The parser reads both TikTok files and the eBay file, drops the cancelled and
          unpaid rows, and turns what is left into the day&rsquo;s boxes. It cannot store
          any of that until the shipping migration has been run.
        </EmptyState>
      </Card>
    </>
  );
}

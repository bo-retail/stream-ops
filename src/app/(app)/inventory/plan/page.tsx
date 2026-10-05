import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Card, CardHeader, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { requireShippingDirector } from "@/lib/auth/guards";
import { formatDate, isDateISO, todayISO } from "@/lib/domain/dates";
import { bringStockUpToDateQuietly } from "@/lib/server/deduction";
import { getSettings } from "@/lib/server/settings";
import { getPlanDay } from "@/lib/server/show-plan";
import { DatePicker, PlanTable } from "./plan-table";

export const metadata: Metadata = { title: "The day's plan" };

/**
 * The day's plan: what goes on eBay at the AM show, what at the PM show, and
 * the rest on TikTok — made in the morning for both shows at once, then the
 * three upload files.
 */
export default async function PlanPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const user = await requireShippingDirector();
  const today = todayISO((await getSettings()).timezone);
  const { date: asked } = await searchParams;
  const date = asked && isDateISO(asked) ? asked : today;
  const run = await bringStockUpToDateQuietly(user.id, { ifChanged: true });
  const day = await getPlanDay(date);
  const held = day.rows.filter((r) => r.missingEbay.length > 0 || r.missingTiktok.length > 0);
  const salesOff = day.startDate === null || day.startDate > date;

  return (
    <>
      <PageHeader
        title="The day's plan"
        description="Both shows are planned in the morning. A watch goes on one show only: AM eBay, PM eBay, or TikTok, which gets everything else."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />

      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <DatePicker date={date} />
          <span className="text-sm text-ink-muted">{formatDate(date, "long")}</span>
        </div>

        {day.missingReports.length > 0 ? (
          <Alert tone="warn">
            Yesterday&apos;s {day.missingReports.join(", ")} report{day.missingReports.length > 1 ? "s are" : " is"} not uploaded yet. Until{" "}
            {day.missingReports.length > 1 ? "they are" : "it is"}, the shelf below still includes what sold yesterday, and the files could offer
            watches that are already sold. Upload {day.missingReports.length > 1 ? "them" : "it"} first, then open this page again.
          </Alert>
        ) : null}
        {run === null ? (
          <Alert tone="warn">Stock could not be brought up to date with the latest sales just now; the shelf below is how it last stood.</Alert>
        ) : null}
        {salesOff ? (
          <Alert tone="warn">
            Sales are not coming off stock for this day yet (see <Link href="/inventory/sales" className="underline">Sales</Link>), so the
            shelf below may include watches already sold.
          </Alert>
        ) : null}
        {!day.shows.AM || !day.shows.PM ? (
          <Alert tone="info">
            The schedule has {!day.shows.AM && !day.shows.PM ? "no eBay show" : `no ${!day.shows.AM ? "AM" : "PM"} eBay show`} this day, so
            the suggestion puts nothing there. You can still plan it by hand.
          </Alert>
        ) : null}
        {day.overListed.length > 0 ? (
          <Alert tone="danger" title="Listed more than is on the shelf">
            Files already downloaded list watches that are no longer all here (sold, given away or moved since). Take these down on the platform by hand:
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              {day.overListed.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </Alert>
        ) : null}
        {day.cuts.length > 0 ? (
          <Alert tone="warn">
            The shelf has changed since the plan was saved. The files not yet downloaded take only what is there now:
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              {day.cuts.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </Alert>
        ) : null}

        <PlanTable
          date={date}
          rows={day.rows}
          proposal={day.proposal}
          saved={day.saved ? { version: day.saved.version, savedAt: day.saved.savedAt.toISOString(), savedBy: day.saved.savedBy } : null}
          current={day.current}
          files={Object.fromEntries(Object.entries(day.files).map(([k, f]) => [k, { at: f.at, by: f.by }]))}
        />

        {held.length > 0 ? (
          <Card>
            <CardHeader
              title={`Not ready for every file (${held.length})`}
              description="These are on the shelf but miss something a platform needs. They stay off that platform until their page is filled in."
            />
            <Table>
              <thead>
                <tr>
                  <Th className="w-14" />
                  <Th>Model</Th>
                  <Th className="text-right">On the shelf</Th>
                  <Th>eBay needs</Th>
                  <Th>TikTok needs</Th>
                </tr>
              </thead>
              <tbody>
                {held.map((r) => (
                  <tr key={r.model}>
                    <Td><WatchImage url={r.picture} model={r.model} size={40} /></Td>
                    <Td><Link href={`/inventory/${encodeURIComponent(r.model)}`} className="font-mono underline">{r.model}</Link></Td>
                    <Td className="text-right tabular-nums">{r.available}</Td>
                    <Td className="text-ink-muted">{r.missingEbay.join(", ") || "—"}</Td>
                    <Td className="text-ink-muted">{r.missingTiktok.join(", ") || "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : null}
      </div>
    </>
  );
}

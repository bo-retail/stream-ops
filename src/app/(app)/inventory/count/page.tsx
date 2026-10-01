import type { Metadata } from "next";
import { LinkButton, PageHeader } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { todayISO } from "@/lib/domain/dates";
import { bringStockUpToDateQuietly } from "@/lib/server/deduction";
import { listStock } from "@/lib/server/inventory";
import { getSettings } from "@/lib/server/settings";
import { AddModel, CountList } from "./count-client";

export const metadata: Metadata = { title: "Count" };

/**
 * The count screen — the main way to count.
 *
 * Find the model, type what is in each place, press Enter. Each model is saved
 * on its own the moment it is entered, so a count can stop and start again
 * without losing anything.
 */
export default async function CountPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireShippingDirector();
  const { q = "" } = await searchParams;
  // The day's packing taken off first, so the numbers to count against are today's.
  await bringStockUpToDateQuietly(user.id);
  const [rows, settings] = await Promise.all([listStock(), getSettings()]);
  // "Counted today" by the business's own day, so the list to work down starts
  // again for each count rather than emptying after the first one.
  const today = todayISO(settings.timezone);
  const dayOf = (d: Date) => todayISO(settings.timezone, d);

  return (
    <>
      <PageHeader
        title="Count"
        description="Count after the day's packing. Find the model, count every spot it is in, type the total, press Enter. Blank means you did not count that place; 0 means none. Watches sold and not yet packed are set aside and not counted. A model is done for today once all five places are counted."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />
      <div className="space-y-5">
        <CountList
          initialSearch={q}
          models={rows.map((r) => ({
            model: r.model,
            description: r.description,
            picture: r.picture,
            // Every place counted today, not just one spot-checked.
            countedToday: r.fullyCountedAt !== null && dayOf(r.fullyCountedAt) === today,
            balances: r.balances,
          }))}
        />
        <AddModel />
      </div>
    </>
  );
}

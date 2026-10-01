import type { Metadata } from "next";
import { LinkButton, PageHeader } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { todayISO } from "@/lib/domain/dates";
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
  await requireShippingDirector();
  const { q = "" } = await searchParams;
  const [rows, settings] = await Promise.all([listStock(), getSettings()]);
  // "Counted today" by the business's own day, so the list to work down starts
  // again for each count rather than emptying after the first one.
  const today = todayISO(settings.timezone);
  const dayOf = (d: Date) => todayISO(settings.timezone, d);

  return (
    <>
      <PageHeader
        title="Count"
        description="Find the model, count every spot it is in, type the total, press Enter. Blank means you did not count that place; 0 means none. A model is done for today once all five places are counted."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />
      <div className="space-y-5">
        <CountList
          initialSearch={q}
          models={rows.map((r) => ({
            model: r.model,
            description: r.description,
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

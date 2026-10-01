import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { Badge, Card, CardHeader, EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { WatchImage } from "@/components/watch-image";
import { requireShippingDirector } from "@/lib/auth/guards";
import { PLACES, PLACE_LABEL } from "@/lib/domain/inventory";
import { ADJUST_REASONS, MOVE_REASONS, RETURN_PLACES, RETURN_TYPES } from "@/lib/domain/movements";
import { getPrompts, recentEntries } from "@/lib/server/movements";
import { PromptButton, RowsForm, UndoButton, UploadTemplate } from "./forms";
import type { Field } from "./forms";

export const metadata: Metadata = { title: "Movements" };

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const PLACE_NAMES = PLACES.map((p) => PLACE_LABEL[p]);

const MOVE_FIELDS: Field[] = [
  { name: "Model #", label: "Model", width: "w-32" },
  { name: "Quantity", label: "How many", width: "w-20", numeric: true },
  { name: "From", label: "From", width: "w-36", options: PLACE_NAMES },
  { name: "To", label: "To", width: "w-36", options: [PLACE_NAMES[1], ...PLACE_NAMES.filter((_, i) => i !== 1)] },
  { name: "Reason", label: "Reason", width: "w-52", options: MOVE_REASONS },
  { name: "Note", label: "Note", width: "w-56" },
];
const ADJUST_FIELDS: Field[] = [
  { name: "Model #", label: "Model", width: "w-32" },
  { name: "Action", label: "Add or take away", width: "w-32", options: ["Subtract", "Add"] },
  { name: "Quantity", label: "How many", width: "w-20", numeric: true },
  { name: "Place", label: "Place", width: "w-36", options: PLACE_NAMES },
  { name: "Reason", label: "Reason", width: "w-36", options: ADJUST_REASONS },
  { name: "Note", label: "Note", width: "w-56" },
];
const RETURN_FIELDS: Field[] = [
  { name: "Model #", label: "Model (the watch in hand)", width: "w-40" },
  { name: "Quantity", label: "How many", width: "w-20", numeric: true },
  { name: "Type", label: "Type", width: "w-40", options: RETURN_TYPES },
  { name: "Goes to", label: "Goes to", width: "w-36", options: RETURN_PLACES },
  { name: "Order #", label: "Order #", width: "w-36" },
  { name: "Condition / note", label: "Condition / note", width: "w-56" },
];

function TemplateLink({ slug, label }: { slug: string; label: string }) {
  return (
    <a
      href={`/api/inventory/template/${slug}`}
      className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-ink hover:bg-canvas"
    >
      <Download className="h-4 w-4" aria-hidden /> {label}
    </a>
  );
}

const KIND_LABEL: Record<string, string> = { MOVES: "Moves", ADJUSTMENTS: "Adjustments", RETURNS: "Returns" };

/**
 * Moving stock by hand: between places, adjustments with a reason, returns
 * and cancellations — typed here, or uploaded on their templates. With what
 * the app suggests at the top (Gladys says yes; nothing moves on its own) and
 * every recent save at the bottom, each with an undo.
 */
export default async function MovementsPage() {
  await requireShippingDirector();
  const [suggestions, entries] = await Promise.all([getPrompts(), recentEntries()]);

  return (
    <>
      <PageHeader
        title="Movements"
        description="Samples, random pulls, damaged, giveaways, returns and cancellations. Type them here, or use the templates."
        action={<LinkButton href="/inventory">Back to inventory</LinkButton>}
      />

      <div className="space-y-5">
        {suggestions.length > 0 ? (
          <Card>
            <CardHeader title="For Gladys to decide" description="The app asks; nothing moves until somebody says yes." />
            <ul className="divide-y divide-line">
              {suggestions.map((s) => (
                <li key={`${s.model}-${s.kind}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <WatchImage url={s.picture} model={s.model} size={56} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      <Link href={`/inventory/${encodeURIComponent(s.model)}`} className="tabular underline">
                        {s.model}
                      </Link>
                      {s.kind === "pull samples" ? " arrived for the first time" : ": nothing left on the shelf"}
                    </p>
                    <p className="text-xs text-ink-muted">{s.text}</p>
                  </div>
                  <PromptButton
                    model={s.model}
                    kind={s.kind}
                    label={
                      s.kind === "pull samples"
                        ? `Pulled ${s.moves.length === 2 ? "one for each table" : "one"}: record it`
                        : "Moved to random pulls: record it"
                    }
                  />
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Move between places" description="The total does not change, only where the pieces are: a sample pulled, a damaged sample, samples to random pulls." />
          <RowsForm kind="MOVES" fields={MOVE_FIELDS} saveLabel="Save the moves" />
          <div className="flex flex-wrap items-start gap-4 border-t border-line p-4">
            <TemplateLink slug="moves" label="Moves template" />
            <div className="min-w-64 flex-1">
              <UploadTemplate kind="MOVES" />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Adjustments"
            description="Add or take away, with a reason. Watches are never lent, only given: a giveaway or content. Damaged moves the pieces to Damaged, where they keep their cost until credited or written off."
          />
          <RowsForm kind="ADJUSTMENTS" fields={ADJUST_FIELDS} saveLabel="Save the adjustments" />
          <div className="flex flex-wrap items-start gap-4 border-t border-line p-4">
            <TemplateLink slug="adjustments" label="Adjustments template" />
            <div className="min-w-64 flex-1">
              <UploadTemplate kind="ADJUSTMENTS" />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Returns and cancellations"
            description="Only once the watch is in Gladys's hand. Give the order number: if it never shipped it comes back out of 'waiting'; if it did, it comes back at the cost it left with. Slightly damaged goes to random pulls. A refund with no watch moves nothing."
          />
          <RowsForm kind="RETURNS" fields={RETURN_FIELDS} saveLabel="Save the returns" />
          <div className="flex flex-wrap items-start gap-4 border-t border-line p-4">
            <TemplateLink slug="returns" label="Returns and cancellations template" />
            <div className="min-w-64 flex-1">
              <UploadTemplate kind="RETURNS" />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Recent saves" description="Newest first. Undo reverses a whole save; nothing is ever deleted from a model's history." />
          {entries.length === 0 ? (
            <EmptyState title="Nothing saved yet">Moves, adjustments and returns appear here.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>What</Th>
                  <Th>By</Th>
                  <Th>
                    <span className="sr-only">Undo</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap text-ink-muted">{when.format(e.at)}</Td>
                    <Td className="text-sm">
                      <Badge tone="neutral">{KIND_LABEL[e.kind] ?? e.kind}</Badge> {e.summary}
                      <span className="block text-xs text-ink-subtle">{e.source}</span>
                    </Td>
                    <Td className="text-ink-muted">{e.by?.name ?? "—"}</Td>
                    <Td className="text-right">
                      {e.undoneAt ? (
                        <span className="text-xs text-ink-subtle">Undone{e.undoneBy ? ` by ${e.undoneBy.name}` : ""}</span>
                      ) : (
                        <UndoButton entryId={e.id} />
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

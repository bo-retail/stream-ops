import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireShippingDirector } from "@/lib/auth/guards";
import { formatDate } from "@/lib/domain/dates";
import { PLATFORM_SHORT } from "@/lib/domain/types";
import { getBoxById, getBoxScans } from "@/lib/server/packing";
import { getSettings } from "@/lib/server/settings";

export const metadata: Metadata = { title: "Box" };

/**
 * Every scan that went into one box.
 *
 * This is the page you open when a customer says they were sent the wrong
 * watch. It establishes that a model was scanned into this box, by a named
 * person, at a known moment — and, just as usefully, that another was refused.
 *
 * Refusals are shown rather than hidden: a rejected scan is the proof that the
 * control worked and the wrong watch was caught before it went in.
 */

const KIND_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  LABEL: { text: "Label scanned", tone: "neutral" },
  ITEM_ACCEPTED: { text: "In the box", tone: "ok" },
  ITEM_REFUSED: { text: "Refused", tone: "danger" },
  ITEM_OVERRIDE: { text: "Added against the report", tone: "warn" },
  ITEM_PLACEHOLDER: { text: "In the box — sold as a placeholder", tone: "ok" },
  CLOSE_COMPLETE: { text: "Closed", tone: "ok" },
  CLOSE_INCOMPLETE: { text: "Closed incomplete", tone: "warn" },
  CLOSE_UNVERIFIED: { text: "Marked sent without scanning", tone: "warn" },
  REOPEN: { text: "Reopened", tone: "warn" },
};

/** How a closed box reads. Never "closed" alone — which kind matters. */
const BOX_STATE: Record<string, string> = {
  CLOSED_COMPLETE: "Closed",
  CLOSED_INCOMPLETE: "Closed incomplete",
  CLOSED_UNVERIFIED: "Marked sent without being scanned here",
};

export default async function BoxPage({ params }: { params: Promise<{ id: string }> }) {
  await requireShippingDirector();

  const { id } = await params;
  const [box, scans, settings] = await Promise.all([
    getBoxById(id),
    getBoxScans(id),
    getSettings(),
  ]);
  if (!box) notFound();

  const stamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return (
    <>
      <PageHeader
        title={box.tracking}
        description={`${
          box.isUnrecognised ? "Not in any report" : `${PLATFORM_SHORT[box.platform]} · ${box.buyer}`
        } · shows of ${formatDate(box.showDate)}`}
        action={
          <Link
            href={`/shipping/log?date=${box.showDate}`}
            className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas"
          >
            ← Back to the log
          </Link>
        }
      />

      <div className="space-y-5">
        <Card>
          <CardHeader
            title="What was in it"
            description={
              box.status === "OPEN"
                ? "Still open."
                : `${BOX_STATE[box.status]}${box.closedByName ? ` by ${box.closedByName}` : ""}.`
            }
          />
          {box.items.length === 0 ? (
            <EmptyState title="Nothing scanned into it">This box is empty.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Stock number</Th>
                  <Th>On the report</Th>
                  <Th>Scanned in</Th>
                </tr>
              </thead>
              <tbody>
                {box.items.map((i) => (
                  <tr key={i.stockNumber}>
                    <Td className="tabular font-medium">
                      {i.stockNumber}
                      {/* The report only said "a piece". Which piece it was is
                          the one thing a dispute about this box turns on. */}
                      {i.placeholder ? (
                        <p className="mt-0.5 text-xs font-normal text-ink-muted">
                          Placeholder listing
                          {i.pieces.length > 0 ? ` — the piece: ${i.pieces.join(", ")}` : " — no piece recorded"}
                        </p>
                      ) : null}
                    </Td>
                    <Td className="tabular text-ink-muted">{i.expected}</Td>
                    <Td className="tabular">
                      {i.scanned > i.expected ? (
                        <span className="font-medium text-warn-700">{i.scanned} — more than the report</span>
                      ) : i.scanned < i.expected ? (
                        <span className="font-medium text-warn-700">{i.scanned} — short</span>
                      ) : (
                        <span className="font-medium text-ok-700">{i.scanned}</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Every scan"
            description="Kept permanently, refusals included. A refusal is the proof the wrong watch was caught."
          />
          {scans.length === 0 ? (
            <EmptyState title="No scans recorded">Nothing has been scanned against this box.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>What happened</Th>
                  <Th>{box.business === "DIAMOND" ? "Piece" : "Watch"}</Th>
                  <Th>By</Th>
                  <Th>Note</Th>
                </tr>
              </thead>
              <tbody>
                {scans.map((s, i) => {
                  const label = KIND_LABEL[s.kind] ?? { text: s.kind, tone: "neutral" as const };
                  return (
                    <tr key={i}>
                      <Td className="tabular whitespace-nowrap text-ink-muted">{stamp.format(s.at)}</Td>
                      <Td>
                        <Badge tone={label.tone}>{label.text}</Badge>
                      </Td>
                      <Td className="tabular font-medium">{s.stockNumber ?? "—"}</Td>
                      <Td className="text-ink-muted">{s.byName}</Td>
                      <Td className="text-ink-muted">{s.note ?? "—"}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>

        <p className="text-xs text-ink-subtle">
          What this proves: that a <strong>model</strong> was scanned into this box, by that person,
          at that moment. Because the barcode is the model rather than the individual watch, it
          cannot tell two of the same model apart — and it records what was <em>scanned</em>, which
          is the closest thing there is to what was sealed in the box.
        </p>
      </div>
    </>
  );
}

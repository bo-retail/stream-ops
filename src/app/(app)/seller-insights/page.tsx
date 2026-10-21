import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireBoss } from "@/lib/auth/guards";
import type { Business } from "@/lib/domain/business";
import { formatDateRange, isDateISO } from "@/lib/domain/dates";
import { formatMoneyShort } from "@/lib/domain/insights";
import { CONFIDENCE_FAIR, CONFIDENCE_SOLID, formatIndex } from "@/lib/domain/sellers";
import type { Confidence, SellerScore } from "@/lib/domain/sellers";
import { PLATFORM_SHORT, slotShort } from "@/lib/domain/types";
import { rangePresets, resolveRange } from "@/lib/server/insights";
import { getSellerInsights } from "@/lib/server/sellers";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Seller insights" };

/**
 * Who sells best, judged fairly.
 *
 * Every show is measured against what its own kind of show normally makes —
 * same platform, same slot, over the same stretch — so being rota'd on nights
 * is not mistaken for selling well. Two readings sit side by side: the plain
 * one (vs expected) and the one with the partner taken out. See
 * `src/lib/domain/sellers.ts` for the method.
 *
 * Boss only. People are promoted on this; it is not a leaderboard for the floor.
 * Watches and diamonds are scored apart, never on one list.
 */

const PERIODS = new Set(["30", "90", "all"]);

function kindLabel(kind: string): string {
  const [platform, slot] = kind.split("|");
  const short = platform === "TIKTOK" || platform === "EBAY" ? PLATFORM_SHORT[platform] : platform;
  return `${short} ${slotShort(slot)}`;
}

function tone(index: number): "ok" | "danger" | "neutral" {
  if (index >= 0.05) return "ok";
  if (index <= -0.05) return "danger";
  return "neutral";
}

/** A score, coloured, with a bar either side of the middle line. */
function Score({ index, max, title }: { index: number; max: number; title?: string }) {
  const t = tone(index);
  const width = max === 0 ? 0 : Math.min(50, (Math.abs(index) / max) * 50);
  return (
    <div className="flex items-center gap-2.5" title={title}>
      <div className="relative h-2 w-24 shrink-0 rounded-full bg-canvas" aria-hidden>
        <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
        <span
          className={cn(
            "absolute inset-y-0 rounded-full",
            index >= 0 ? "left-1/2" : "right-1/2",
            t === "ok" && "bg-ok-500",
            t === "danger" && "bg-danger-500",
            t === "neutral" && "bg-ink-subtle",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
      <span
        className={cn(
          "tabular w-12 text-right font-semibold",
          t === "ok" && "text-ok-700",
          t === "danger" && "text-danger-600",
          t === "neutral" && "text-ink-muted",
        )}
      >
        {formatIndex(index)}
      </span>
    </div>
  );
}

const CONFIDENCE_BADGE: Record<Confidence, { tone: "ok" | "warn" | "neutral"; label: string }> = {
  solid: { tone: "ok", label: "Solid" },
  fair: { tone: "warn", label: "Fair" },
  early: { tone: "neutral", label: "Too early" },
};

function hours(minutes: number): string {
  return `${Math.round(minutes / 60)}h`;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{children}</h2>
      <span className="h-px flex-1 bg-line" aria-hidden />
    </div>
  );
}

export default async function SellerInsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; period?: string; from?: string; to?: string }>;
}) {
  await requireBoss();

  const query = await searchParams;
  const business: Business = query.business === "DIAMOND" ? "DIAMOND" : "WATCH";
  const presets = (await rangePresets()).filter((p) => PERIODS.has(p.key));
  // Ninety days by default: a month is too few shows to say much about anybody.
  const range = resolveRange(
    presets,
    query.period && PERIODS.has(query.period) ? query.period : "90",
    query.from && isDateISO(query.from) ? query.from : undefined,
    query.to && isDateISO(query.to) ? query.to : undefined,
  );

  const data = await getSellerInsights(business, range.from, range.to);
  const name = (id: string) => data.names[id]?.name ?? "Unknown";
  const ranked = data.sellers.filter((s) => s.ranked);
  const early = data.sellers.filter((s) => !s.ranked);
  const max = Math.max(0.2, ...data.sellers.flatMap((s) => [Math.abs(s.index), Math.abs(s.effect)]));

  const href = (over: { business?: Business; period?: string }) => {
    const b = over.business ?? business;
    const p = over.period ?? (range.key === "custom" ? undefined : range.key);
    const params = new URLSearchParams({ business: b });
    if (p) params.set("period", p);
    else {
      params.set("from", range.from);
      params.set("to", range.to);
    }
    return `/seller-insights?${params}`;
  };

  // Kinds in the order they earn, for the "where each sells best" columns.
  const kinds = data.baselines.map((b) => b.kind);

  const partnerNote = (s: SellerScore) => {
    if (!s.mainPartner || s.mainPartner.share < 0.6) return null;
    return `Mostly with ${name(s.mainPartner.userId)} (${Math.round(s.mainPartner.share * 100)}% of paired shows) — the partner-adjusted figure is less certain.`;
  };

  const bestPairs = data.pairings.slice(0, 8);
  // The weakest five, never overlapping the top eight.
  const worstPairs = data.pairings.slice(Math.max(8, data.pairings.length - 5)).reverse();

  return (
    <>
      <PageHeader
        title="Seller insights"
        description={`${business === "DIAMOND" ? "Diamond" : "Watch"} streamers · ${formatDateRange(range.from, range.to)}`}
      />

      <div className="no-print mb-5 flex flex-wrap items-center gap-2.5">
        <div className="inline-flex items-center gap-0.5 rounded-xl border border-line bg-surface p-1">
          {(["WATCH", "DIAMOND"] as const).map((b) => (
            <Link
              key={b}
              href={href({ business: b })}
              aria-current={b === business ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-colors",
                b === business ? "bg-brand-600 text-white" : "text-ink-muted hover:bg-canvas hover:text-ink",
              )}
            >
              {b === "WATCH" ? "Watches" : "Diamonds"}
            </Link>
          ))}
        </div>
        <div className="inline-flex items-center gap-0.5 rounded-xl border border-line bg-surface p-1">
          {presets.map((p) => (
            <Link
              key={p.key}
              href={href({ period: p.key })}
              aria-current={p.key === range.key ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-colors",
                p.key === range.key ? "bg-brand-600 text-white" : "text-ink-muted hover:bg-canvas hover:text-ink",
              )}
            >
              {p.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="space-y-5">
        <Card className="p-4 text-sm text-ink-muted">
          <p>
            <span className="font-semibold text-ink">How to read this.</span> Every show is compared with
            what that kind of show normally makes per hour — same platform, same slot (day, night, or an
            extra show), over this period. A busy month lifts every show in it, so compare people over
            the same stretch. <span className="font-semibold text-ink">Vs expected</span> is how a person&apos;s
            shows did against that, shared with whoever they were on with.{" "}
            <span className="font-semibold text-ink">Partner-adjusted</span> takes the partner out, by
            comparing the same person across different partners. When the two agree, trust it; when they
            disagree, the partner is the reason. Both are pulled toward average while someone has few
            shows, and nobody is ranked under {CONFIDENCE_FAIR} shows.
          </p>
        </Card>

        {data.sellers.length === 0 ? (
          <Card>
            <EmptyState title="No shows to score in this period">
              Scores appear once shows with people on them have their sales files loaded.
            </EmptyState>
          </Card>
        ) : (
          <>
            <SectionTitle>Ranked</SectionTitle>
            <Card>
              {ranked.length === 0 ? (
                <EmptyState title={`Nobody has ${CONFIDENCE_FAIR} shows yet in this period`}>
                  Try a longer period.
                </EmptyState>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-8">#</Th>
                      <Th>Streamer</Th>
                      <Th className="text-right">Shows</Th>
                      <Th className="text-right">Hours</Th>
                      <Th className="text-right">Net sales</Th>
                      <Th className="text-right">Per hour</Th>
                      <Th>Vs expected</Th>
                      <Th>Partner-adjusted</Th>
                      <Th>How sure</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((s, i) => {
                      const note = partnerNote(s);
                      const left = data.names[s.userId] && !data.names[s.userId].active;
                      return (
                        <tr key={s.userId}>
                          <Td className="tabular text-ink-subtle">{i + 1}</Td>
                          <Td className="font-medium">
                            {name(s.userId)}
                            {left ? <span className="ml-1.5 text-xs font-normal text-ink-subtle">(left)</span> : null}
                            {note ? <p className="mt-0.5 max-w-xs text-xs font-normal text-warn-700">{note}</p> : null}
                          </Td>
                          <Td className="tabular text-right">{s.shows}</Td>
                          <Td className="tabular text-right text-ink-muted">{hours(s.minutes)}</Td>
                          <Td className="tabular text-right">{formatMoneyShort(s.revenueCents)}</Td>
                          <Td className="tabular text-right text-ink-muted">
                            {formatMoneyShort(s.minutes === 0 ? 0 : Math.round(s.revenueCents / (s.minutes / 60)))}
                          </Td>
                          <Td>
                            <Score
                              index={s.index}
                              max={max}
                              title={`Before the pull toward average: ${formatIndex(s.rawIndex)}. These shows normally make ${formatMoneyShort(s.expectedCents)}.`}
                            />
                          </Td>
                          <Td>
                            <Score index={s.effect} max={max} />
                          </Td>
                          <Td>
                            <Badge tone={CONFIDENCE_BADGE[s.confidence].tone}>{CONFIDENCE_BADGE[s.confidence].label}</Badge>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </Card>

            {early.length > 0 ? (
              <>
                <SectionTitle>Too early to rank — under {CONFIDENCE_FAIR} shows</SectionTitle>
                <Card>
                  <Table>
                    <thead>
                      <tr>
                        <Th>Streamer</Th>
                        <Th className="text-right">Shows</Th>
                        <Th className="text-right">Net sales</Th>
                        <Th>Vs expected so far</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {early.map((s) => (
                        <tr key={s.userId}>
                          <Td className="font-medium">{name(s.userId)}</Td>
                          <Td className="tabular text-right">{s.shows}</Td>
                          <Td className="tabular text-right">{formatMoneyShort(s.revenueCents)}</Td>
                          <Td>
                            <Score index={s.index} max={max} title={`Before the pull toward average: ${formatIndex(s.rawIndex)}`} />
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              </>
            ) : null}

            <SectionTitle>Where each sells best</SectionTitle>
            <Card>
              <CardHeader
                title="Vs expected, by kind of show"
                description="Not pulled toward average — a cell with few shows is a hint, not a verdict."
              />
              <Table>
                <thead>
                  <tr>
                    <Th>Streamer</Th>
                    {kinds.map((k) => (
                      <Th key={k}>{kindLabel(k)}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.sellers.map((s) => (
                    <tr key={s.userId}>
                      <Td className="font-medium">{name(s.userId)}</Td>
                      {kinds.map((k) => {
                        const cell = s.byKind.find((b) => b.kind === k);
                        if (!cell) return <Td key={k} className="text-ink-subtle">—</Td>;
                        const t = tone(cell.index);
                        return (
                          <Td key={k} className="tabular whitespace-nowrap">
                            <span
                              className={cn(
                                "font-semibold",
                                t === "ok" && "text-ok-700",
                                t === "danger" && "text-danger-600",
                                t === "neutral" && "text-ink-muted",
                              )}
                            >
                              {formatIndex(cell.index)}
                            </span>
                            <span className="ml-1 text-xs text-ink-subtle">
                              {cell.shows} show{cell.shows === 1 ? "" : "s"}
                            </span>
                          </Td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>

            <SectionTitle>Pairings</SectionTitle>
            <Card>
              <CardHeader
                title="How pairs do together"
                description="Pairs with at least 3 shows together. “Vs their usual” compares the pair with what the two of them do with other partners — positive means they are better together. It needs 10 shows together and 10 each apart, and a difference smaller than their nights normally swing by reads “No clear difference”."
              />
              {data.pairings.length === 0 ? (
                <EmptyState title="No pair has worked 3 shows together in this period" />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Pair</Th>
                      <Th className="text-right">Shows together</Th>
                      <Th>Vs expected</Th>
                      <Th>Vs their usual</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...bestPairs, ...worstPairs].map((p, i) => (
                      <tr key={`${p.a}|${p.b}`} className={cn(i === bestPairs.length && "border-t-4 border-line")}>
                        <Td className="font-medium">
                          {name(p.a)} &amp; {name(p.b)}
                        </Td>
                        <Td className="tabular text-right">{p.shows}</Td>
                        <Td>
                          <Score index={p.together} max={max} />
                        </Td>
                        <Td>
                          {p.chemistry === null ? (
                            <span className="text-xs text-ink-subtle" title="Fewer than 10 shows together, or fewer than 10 each apart">
                              Not enough shows yet
                            </span>
                          ) : p.chemistryClear ? (
                            <Score index={p.chemistry} max={max} />
                          ) : (
                            <span
                              className="text-xs text-ink-subtle"
                              title={`${formatIndex(p.chemistry)} — inside how much their nights normally swing`}
                            >
                              No clear difference
                            </span>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {worstPairs.length > 0 ? (
                <p className="px-4 py-2.5 text-xs text-ink-subtle">Top 8, then the 5 weakest.</p>
              ) : null}
            </Card>

            <SectionTitle>What a typical show makes</SectionTitle>
            <Card>
              <Table>
                <thead>
                  <tr>
                    <Th>Kind of show</Th>
                    <Th className="text-right">Shows</Th>
                    <Th className="text-right">Normal per hour</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.baselines.map((b) => (
                    <tr key={b.kind}>
                      <Td className="font-medium">{kindLabel(b.kind)}</Td>
                      <Td className="tabular text-right">{b.shows}</Td>
                      <Td className="tabular text-right">{formatMoneyShort(b.perHourCents)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="px-4 py-2.5 text-xs text-ink-subtle">
                Net sales after discounts, per scheduled hour. Only streamers are scored. {data.showsScored} shows scored
                {data.showsWithoutSales > 0
                  ? ` · ${data.showsWithoutSales} left out because their sales file is not loaded yet`
                  : ""}
                . Fair from {CONFIDENCE_FAIR} shows, solid from {CONFIDENCE_SOLID}.
              </p>
            </Card>
          </>
        )}
      </div>
    </>
  );
}

"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Check, CopyPlus, Eraser, Send, Wand2, X } from "lucide-react";
import { Alert, Badge, Button, Card, CardHeader, Input, Select } from "@/components/ui";
import { SLOT_SHORT } from "@/lib/domain/types";
import type { Slot } from "@/lib/domain/types";
import {
  clearRelease,
  commitSchedule,
  copyLastRelease,
  generateSchedule,
  publishRelease,
  setSlotHoursForRelease,
} from "./actions";
import type { ActionState, GenerateState, Proposal } from "./actions";

function Submit({
  label,
  busy,
  variant = "primary",
  disabled,
  icon,
}: {
  label: string;
  busy: string;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="sm" disabled={pending || disabled}>
      {icon}
      {pending ? busy : label}
    </Button>
  );
}

function Result({ state }: { state: ActionState }) {
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  if (state.ok) return <Alert tone="ok">{state.ok}</Alert>;
  return null;
}

/**
 * The generated schedule, before it is written.
 *
 * Shown in full rather than as a count: confirming is the moment the boss takes
 * responsibility for it, so what they are agreeing to has to be on screen —
 * including the seats it could not fill, which are the part worth arguing with.
 */
function ProposalPreview({
  proposal,
  onDiscard,
  commitState,
  commitAction,
}: {
  proposal: Proposal;
  onDiscard: () => void;
  commitState: ActionState;
  commitAction: (formData: FormData) => void;
}) {
  const perPerson = new Map<string, number>();
  for (const pick of proposal.picks) {
    perPerson.set(pick.userName, (perPerson.get(pick.userName) ?? 0) + 1);
  }
  const tally = [...perPerson.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  // The panel is taller than the window, so a card appearing below the fold
  // looks exactly like the button doing nothing. Bring it to the eye.
  //
  // Deliberately plain: an instant jump rather than a smooth one, and no
  // requestAnimationFrame. Smooth scrolling is silently ignored in some
  // embedded browsers, and rAF never fires at all in a background tab — this is
  // the one moment where landing somewhere visible matters more than landing
  // there prettily.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "start" });
  }, []);

  const byDate = new Map<string, typeof proposal.picks>();
  for (const pick of proposal.picks) {
    const list = byDate.get(pick.dateISO) ?? [];
    list.push(pick);
    byDate.set(pick.dateISO, list);
  }

  return (
    <div ref={ref} className="scroll-mt-4">
    <Card className="border-brand-300 ring-2 ring-brand-200">
      <CardHeader
        title="Proposed schedule"
        description="Nothing has been saved yet. Look it over, then confirm."
        action={<Badge tone="brand">Draft</Badge>}
      />
      <div className="space-y-4 p-4">
        <p className="text-sm text-ink-muted">
          {proposal.picks.length} seat{proposal.picks.length === 1 ? "" : "s"} to fill
          {proposal.keptSeats > 0 ? `, ${proposal.keptSeats} already set and left alone` : ""}
          {proposal.gaps.length > 0 ? `, ${proposal.gaps.length} it could not fill` : ""}.
        </p>

        {proposal.gaps.length > 0 ? (
          <Alert tone="danger" title={`${proposal.gaps.length} seat(s) left empty`}>
            <ul className="mt-1 space-y-0.5">
              {proposal.gaps.slice(0, 6).map((gap, i) => (
                <li key={i}>
                  {gap.showLabel}, seat {gap.seat} — {gap.reason.toLowerCase()}
                </li>
              ))}
              {proposal.gaps.length > 6 ? <li>…and {proposal.gaps.length - 6} more.</li> : null}
            </ul>
            <p className="mt-1.5">
              Nobody is put on a show they did not offer. Fill these by hand, or ask for more
              availability.
            </p>
          </Alert>
        ) : null}

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            Shows each person picks up
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink">
            {tally.map(([name, n]) => (
              <li key={name}>
                {name} <span className="tabular font-semibold">{n}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="max-h-80 overflow-y-auto rounded-md border border-line">
          <ul className="divide-y divide-line">
            {[...byDate.entries()].map(([dateISO, picks]) => (
              <li key={dateISO} className="px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                  {picks[0].showLabel.split(" on ")[1]}
                </p>
                <ul className="mt-1 space-y-0.5 text-sm text-ink">
                  {picks.map((pick) => (
                    <li key={`${pick.showId}-${pick.seat}`} className="flex justify-between gap-3">
                      <span>{pick.showLabel.split(" on ")[0]}</span>
                      <span className="text-ink-muted">
                        {pick.userName}{" "}
                        <span className="tabular text-xs">
                          {pick.startHM}–{pick.endHM}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <form action={commitAction}>
            <input type="hidden" name="releaseId" value={proposal.releaseId} />
            <input
              type="hidden"
              name="picks"
              value={JSON.stringify(
                proposal.picks.map((p) => ({
                  showId: p.showId,
                  seat: p.seat,
                  userId: p.userId,
                })),
              )}
            />
            <Submit
              label={`Confirm ${proposal.picks.length} seat${proposal.picks.length === 1 ? "" : "s"}`}
              busy="Saving…"
              icon={<Check className="h-4 w-4" aria-hidden />}
            />
          </form>
          <Button type="button" size="sm" variant="secondary" onClick={onDiscard}>
            <X className="h-4 w-4" aria-hidden />
            Discard
          </Button>
        </div>
        {commitState.error ? <Alert tone="danger">{commitState.error}</Alert> : null}
      </div>
    </Card>
    </div>
  );
}

/** What this release asked for, in a line, so it is not a mystery at generate time. */
function RulesLine({
  rules,
}: {
  rules: {
    usePriority: boolean;
    useProportional: boolean;
    priorityNames: string[];
    maxShowsPerPerson: number | null;
  };
}) {
  const parts: string[] = [];
  parts.push(
    rules.useProportional
      ? "work split in proportion to what people offered"
      : "an even spread regardless of availability",
  );
  parts.push(
    rules.usePriority && rules.priorityNames.length > 0
      ? `priority to ${rules.priorityNames.join(", ")}`
      : "nobody has priority",
  );
  if (rules.maxShowsPerPerson) parts.push(`at most ${rules.maxShowsPerPerson} shows each`);

  return (
    <p className="text-xs text-ink-muted">
      <span className="font-medium text-ink">This release:</span> {parts.join(" · ")}.
    </p>
  );
}

/**
 * The master controls: everything that acts on the whole release at once, rather
 * than one show at a time.
 */
export function ReleaseActions({
  releaseId,
  errors,
  warnings,
  canPublish,
  openSeats,
  alreadyPublished,
  version,
  rules,
  slotHours,
}: {
  releaseId: string;
  errors: string[];
  warnings: string[];
  canPublish: boolean;
  openSeats: number;
  alreadyPublished: boolean;
  version: number;
  rules: {
    usePriority: boolean;
    useProportional: boolean;
    priorityNames: string[];
    maxShowsPerPerson: number | null;
  };
  slotHours: Record<Slot, { start: string; end: string }>;
}) {
  const [publishState, publishAction] = useActionState<ActionState, FormData>(publishRelease, {});
  const [copyState, copyAction] = useActionState<ActionState, FormData>(copyLastRelease, {});
  const [clearState, clearAction] = useActionState<ActionState, FormData>(clearRelease, {});
  const [genState, genAction] = useActionState<GenerateState, FormData>(generateSchedule, {});
  const [commitState, commitAction] = useActionState<ActionState, FormData>(commitSchedule, {});
  const [discarded, setDiscarded] = useState(false);
  const [hoursState, hoursAction] = useActionState<ActionState, FormData>(
    setSlotHoursForRelease,
    {},
  );

  // A fresh generate replaces whatever was discarded before it; a successful
  // confirm clears the preview, since it is now the real schedule.
  const proposal = genState.proposal ?? null;
  useEffect(() => setDiscarded(false), [proposal]);
  useEffect(() => {
    if (commitState.ok) setDiscarded(true);
  }, [commitState.ok]);

  return (
    <div className="space-y-5">
      {/* Generating is the point of the page, so it is the first thing in the
          panel — and the proposal lands directly under the button that made it,
          not below three other cards where it reads as nothing having happened. */}
      <Card>
        <CardHeader
          title="Build the schedule"
          description="From everyone's availability. Nothing is saved until you confirm it."
        />
        <div className="space-y-3 p-4">
          <form action={genAction}>
            <input type="hidden" name="releaseId" value={releaseId} />
            <Submit
              label="Generate schedule"
              busy="Working it out…"
              icon={<Wand2 className="h-4 w-4" aria-hidden />}
            />
          </form>
          <RulesLine rules={rules} />
          <p className="text-xs text-ink-muted">
            Shows you who would go where before it writes anything. Only uses people who offered
            that exact show, never moves anyone already placed, and spreads the work evenly.
            Anything it cannot fill is left empty.
          </p>
          {genState.error ? <Alert tone="danger">{genState.error}</Alert> : null}
          <Result state={commitState} />

          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            <form action={copyAction}>
              <input type="hidden" name="releaseId" value={releaseId} />
              <Submit
                label="Copy last release"
                busy="Copying…"
                variant="secondary"
                icon={<CopyPlus className="h-4 w-4" aria-hidden />}
              />
            </form>
            <form action={clearAction}>
              <input type="hidden" name="releaseId" value={releaseId} />
              <Submit
                label="Clear everyone"
                busy="Clearing…"
                variant="secondary"
                icon={<Eraser className="h-4 w-4" aria-hidden />}
              />
            </form>
          </div>
          <Result state={copyState} />
          <Result state={clearState} />
        </div>
      </Card>

      {proposal && !discarded ? (
        <ProposalPreview
          proposal={proposal}
          onDiscard={() => setDiscarded(true)}
          commitState={commitState}
          commitAction={commitAction}
        />
      ) : null}

      <Card>
        <CardHeader
          title="Publish"
          description={
            alreadyPublished
              ? `Published as version ${version}. Publishing again saves a new version.`
              : "The team only sees a period once it is published."
          }
        />
        <div className="space-y-3 p-4">
          {errors.length > 0 ? (
            <Alert tone="danger" title={`${errors.length} thing${errors.length === 1 ? "" : "s"} to fix first`}>
              <ul className="mt-1 space-y-0.5">
                {errors.slice(0, 6).map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
                {errors.length > 6 ? <li>…and {errors.length - 6} more.</li> : null}
              </ul>
            </Alert>
          ) : null}

          {openSeats > 0 ? (
            <Alert
              tone="warn"
              title={`${openSeats} seat${openSeats === 1 ? "" : "s"} still open`}
            >
              You can publish anyway. The gaps stay visible here and in the grid, and you can fill
              them once you have spoken to people — publishing again saves a new version.
            </Alert>
          ) : null}

          {warnings.length > 0 ? (
            <Alert tone="warn" title={`${warnings.length} thing${warnings.length === 1 ? "" : "s"} worth a look`}>
              <ul className="mt-1 space-y-0.5">
                {warnings.slice(0, 5).map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
                {warnings.length > 5 ? <li>…and {warnings.length - 5} more.</li> : null}
              </ul>
              <p className="mt-1.5">These do not stop you publishing.</p>
            </Alert>
          ) : null}

          {errors.length === 0 && warnings.length === 0 && openSeats === 0 ? (
            <Alert tone="ok">Every show has both people. Nothing to flag.</Alert>
          ) : null}

          <form action={publishAction}>
            <input type="hidden" name="releaseId" value={releaseId} />
            <Submit
              label={alreadyPublished ? "Publish again" : "Publish this period"}
              busy="Publishing…"
              disabled={!canPublish}
              icon={<Send className="h-4 w-4" aria-hidden />}
            />
          </form>
          <Result state={publishState} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Show hours"
          description="Change a slot's hours across the whole period. Individual shows can still be adjusted on their own."
        />
        <div className="space-y-3 p-4">
          <form action={hoursAction} className="space-y-2">
            <input type="hidden" name="releaseId" value={releaseId} />
            <Select name="slot" defaultValue="DAY" aria-label="Which slot">
              {(["DAY", "NIGHT"] as const).map((slot) => (
                <option key={slot} value={slot}>
                  Every {SLOT_SHORT[slot].toLowerCase()} show
                </option>
              ))}
            </Select>
            <div className="flex items-center gap-2">
              <Input
                name="start"
                type="time"
                defaultValue={slotHours.DAY.start}
                aria-label="Start time"
                required
              />
              <span className="text-sm text-ink-subtle">to</span>
              <Input
                name="end"
                type="time"
                defaultValue={slotHours.DAY.end}
                aria-label="End time"
                required
              />
            </div>
            <Submit label="Apply to the period" busy="Applying…" variant="secondary" />
          </form>
          <p className="text-xs text-ink-muted">
            Currently {slotHours.DAY.start}–{slotHours.DAY.end} days,{" "}
            {slotHours.NIGHT.start}–{slotHours.NIGHT.end} nights.
          </p>
          <Result state={hoursState} />
        </div>
      </Card>

    </div>
  );
}

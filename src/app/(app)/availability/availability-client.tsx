"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Check, CopyPlus, Eraser } from "lucide-react";
import { Alert, Badge, Button, Card, CardHeader, Select } from "@/components/ui";
import { formatDate } from "@/lib/domain/dates";
import { SLOT_SHORT } from "@/lib/domain/types";
import type { DateISO, Slot } from "@/lib/domain/types";
import { cn } from "@/lib/utils";
import {
  clearPeriodAvailability,
  copyLastPeriodAvailability,
  fillPeriod,
  submitAvailability,
  toggleShow,
} from "./actions";
import type { AvailabilityState } from "./actions";
import { toggleDayOff } from "./timeOffActions";
import type { TimeOffState } from "./timeOffActions";

export interface SlotOption {
  dateISO: DateISO;
  slot: Slot;
  startHM: string;
  endHM: string;
  cancelled: boolean;
  /** True when this person has offered to work it. */
  offered: boolean;
}

function Submit({
  label,
  busy,
  variant = "primary",
  icon,
}: {
  label: string;
  busy: string;
  variant?: "primary" | "secondary" | "ghost";
  icon?: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {icon}
      {pending ? busy : label}
    </Button>
  );
}

function Result({ state }: { state: AvailabilityState }) {
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  return null;
}

/**
 * One show a person can offer.
 *
 * The whole tile is the control: tap to offer it, tap again to take it back.
 * There is nothing else to say — the two people on a show split it and swap
 * halfway, so there is no job to choose between.
 */
function SlotTile({
  releaseId,
  option,
  locked,
  dayOff,
}: {
  releaseId: string;
  option: SlotOption;
  locked: boolean;
  dayOff: boolean;
}) {
  const [state, action] = useActionState<AvailabilityState, FormData>(toggleShow, {});
  const router = useRouter();

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  const offered = option.offered;
  const disabled = locked || dayOff || option.cancelled;

  return (
    <div
      className={cn(
        "rounded-lg border p-2.5",
        offered ? "border-ok-200 bg-ok-50" : "border-line bg-surface",
        disabled && "opacity-60",
      )}
    >
      <form action={action}>
        <input type="hidden" name="releaseId" value={releaseId} />
        <input type="hidden" name="dateISO" value={option.dateISO} />
        <input type="hidden" name="slot" value={option.slot} />

        <button
          type="submit"
          disabled={disabled}
          className="flex w-full items-center justify-between gap-2 text-left disabled:cursor-not-allowed"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink">{SLOT_SHORT[option.slot]}</span>
            <span className="block text-xs text-ink-muted">
              {option.startHM}–{option.endHM}
            </span>
          </span>
          {offered ? (
            <Check className="h-4 w-4 shrink-0 text-ok-700" aria-hidden />
          ) : (
            <span className="shrink-0 text-xs text-ink-subtle">
              {option.cancelled ? "Off" : "Tap"}
            </span>
          )}
        </button>
      </form>

      {state.error ? (
        <p className="mt-1 text-xs font-medium text-danger-600">{state.error}</p>
      ) : null}
    </div>
  );
}

function DayCard({
  releaseId,
  dateISO,
  options,
  locked,
  dayOff,
}: {
  releaseId: string;
  dateISO: DateISO;
  options: SlotOption[];
  locked: boolean;
  dayOff: boolean;
}) {
  const [state, action] = useActionState<TimeOffState, FormData>(toggleDayOff, {});
  const router = useRouter();

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  const offeredCount = options.filter((o) => o.offered).length;

  return (
    <Card className={cn(dayOff && "opacity-75")}>
      <CardHeader
        title={formatDate(dateISO, "long")}
        description={
          dayOff
            ? "You have this day off."
            : offeredCount === 0
              ? "Nothing offered yet."
              : `${offeredCount} offered.`
        }
        action={
          !locked ? (
            <form action={action}>
              <input type="hidden" name="dateISO" value={dateISO} />
              <Submit
                label={dayOff ? "I can work" : "Day off"}
                busy="Saving…"
                variant={dayOff ? "secondary" : "ghost"}
              />
            </form>
          ) : dayOff ? (
            <Badge tone="neutral">Day off</Badge>
          ) : null
        }
      />
      <div className="grid grid-cols-2 gap-2 p-3">
        {options.map((option) => (
          <SlotTile
            key={option.slot}
            releaseId={releaseId}
            option={option}
            locked={locked}
            dayOff={dayOff}
          />
        ))}
        {options.length === 0 ? (
          <p className="col-span-2 py-2 text-sm text-ink-muted">No shows scheduled this day.</p>
        ) : null}
      </div>
      {state.error ? (
        <p className="px-4 pb-3 text-xs font-medium text-danger-600">{state.error}</p>
      ) : null}
    </Card>
  );
}

export function AvailabilityEditor({
  releaseId,
  dates,
  options,
  daysOff,
  locked,
}: {
  releaseId: string;
  dates: DateISO[];
  options: SlotOption[];
  daysOff: DateISO[];
  locked: boolean;
}) {
  const [fillState, fillAction] = useActionState<AvailabilityState, FormData>(fillPeriod, {});
  const [clearState, clearAction] = useActionState<AvailabilityState, FormData>(
    clearPeriodAvailability,
    {},
  );
  const [copyState, copyAction] = useActionState<AvailabilityState, FormData>(
    copyLastPeriodAvailability,
    {},
  );

  return (
    <div className="space-y-4">
      {!locked ? (
        <Card>
          <CardHeader
            title="Quick fill"
            description="Set the whole period at once, then adjust any day below."
          />
          <div className="space-y-3 p-4">
            <form action={fillAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="releaseId" value={releaseId} />
              <Select name="slot" defaultValue="BOTH" aria-label="Which shows" className="w-auto">
                <option value="BOTH">Both shows, every day</option>
                <option value="DAY">Day shows only</option>
                <option value="NIGHT">Night shows only</option>
              </Select>
              <Submit label="Offer these" busy="Saving…" />
            </form>
            <p className="text-xs text-ink-muted">Days you have booked off are skipped.</p>

            <div className="flex flex-wrap gap-2 border-t border-line pt-3">
              <form action={copyAction}>
                <input type="hidden" name="releaseId" value={releaseId} />
                <Submit
                  label="Same as last period"
                  busy="Copying…"
                  variant="secondary"
                  icon={<CopyPlus className="h-4 w-4" aria-hidden />}
                />
              </form>
              <form action={clearAction}>
                <input type="hidden" name="releaseId" value={releaseId} />
                <Submit
                  label="Clear the period"
                  busy="Clearing…"
                  variant="secondary"
                  icon={<Eraser className="h-4 w-4" aria-hidden />}
                />
              </form>
            </div>

            <Result state={fillState} />
            <Result state={clearState} />
            <Result state={copyState} />
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {dates.map((dateISO) => (
          <DayCard
            key={dateISO}
            releaseId={releaseId}
            dateISO={dateISO}
            options={options.filter((o) => o.dateISO === dateISO)}
            locked={locked}
            dayOff={daysOff.includes(dateISO)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The one deliberate act on this page.
 *
 * Everything above it saves as you tap, but none of it counts until this is
 * pressed — so the button says what it is about to do and how much of the
 * period has been answered. Sending in nothing is allowed, because "I cannot
 * work this period" is a real answer, but the button changes its wording so
 * nobody presses it thinking it saves what they tapped.
 */
export function SubmitAvailability({
  releaseId,
  releaseLabel,
  offeredCount,
  dayCount,
}: {
  releaseId: string;
  releaseLabel: string;
  offeredCount: number;
  dayCount: number;
}) {
  const [state, action] = useActionState<AvailabilityState, FormData>(submitAvailability, {});
  const nothing = offeredCount === 0;

  return (
    <Card className={nothing ? undefined : "border-brand-300"}>
      <CardHeader
        title="Send it in"
        description={`Your admin builds the schedule from this. You cannot change it afterwards without asking them.`}
      />
      <div className="space-y-3 p-4">
        <p className="text-sm text-ink">
          {nothing ? (
            <>
              You have not offered <strong>any</strong> shows across the {dayCount} days of{" "}
              {releaseLabel}. If that is right, send it in and your admin will know not to schedule
              you. If not, tap the shows you can work first.
            </>
          ) : (
            <>
              <strong>
                {offeredCount} show{offeredCount === 1 ? "" : "s"}
              </strong>{" "}
              offered across the {dayCount} days of {releaseLabel}. The more you offer, the more you
              are scheduled.
            </>
          )}
        </p>

        <form action={action}>
          <input type="hidden" name="releaseId" value={releaseId} />
          <SendButton nothing={nothing} count={offeredCount} />
        </form>

        <p className="text-xs text-ink-muted">
          Once sent, this locks. Ask your admin to reopen it if something changes.
        </p>

        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <Result state={state} />
      </div>
    </Card>
  );
}

function SendButton({ nothing, count }: { nothing: boolean; count: number }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={nothing ? "secondary" : "primary"} disabled={pending}>
      <Check className="h-4 w-4" aria-hidden />
      {pending
        ? "Sending…"
        : nothing
          ? "Send in — I cannot work any shows"
          : `Send in ${count} show${count === 1 ? "" : "s"}`}
    </Button>
  );
}

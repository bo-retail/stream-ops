"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { Ban, Clock, RotateCcw, X } from "lucide-react";
import { PlatformBadge } from "@/components/show-labels";
import { Alert, Badge, Button, Card, CardHeader, Input, Select } from "@/components/ui";
import { formatDate, formatMinutes } from "@/lib/domain/dates";
import { SLOT_SHORT } from "@/lib/domain/types";
import type { DateISO, Platform, ShowStatus, Slot } from "@/lib/domain/types";
import { cn } from "@/lib/utils";
import { assignToShow, clearSeat, toggleShowCancelled, updateShowHours } from "./actions";
import type { ActionState } from "./actions";
import { seatKey } from "./seat-key";

export interface BuilderSeat {
  /** 1 or 2. Meaningless to the user — the pair swap jobs halfway. */
  seat: number;
  userId: string | null;
  userName: string | null;
  /** Set when this person is a questionable choice — why, in plain words. */
  flag: string | null;
}

export interface BuilderShow {
  id: string;
  dateISO: DateISO;
  platform: Platform;
  slot: Slot;
  status: ShowStatus;
  startHM: string;
  endHM: string;
  minutes: number;
  notes: string | null;
  seats: BuilderSeat[];
}

export interface BuilderPerson {
  id: string;
  name: string;
  shows: number;
  tiktok: number;
  ebay: number;
}

/**
 * What each person is carrying so far, TikTok against eBay.
 *
 * Sat above the day cards rather than in a sidebar: the number that matters is
 * the one you are about to change, and it wants to be in the same glance as the
 * seat you are filling. Busiest first, so an uneven split is obvious without
 * reading every row; a dash rather than a zero for anybody on nothing, because a
 * column of zeroes reads as noise while a dash reads as "still to place".
 */
function PersonTally({ people }: { people: BuilderPerson[] }) {
  const ranked = [...people].sort((a, b) => b.shows - a.shows || a.name.localeCompare(b.name));
  const total = people.reduce((n, p) => n + p.shows, 0);
  const tiktok = people.reduce((n, p) => n + p.tiktok, 0);
  const ebay = people.reduce((n, p) => n + p.ebay, 0);

  return (
    <Card>
      <CardHeader
        title="Shifts each person has"
        description={
          total === 0
            ? "Nobody is placed yet."
            : `${total} seat${total === 1 ? "" : "s"} filled — ${tiktok} TikTok, ${ebay} eBay.`
        }
      />
      <ul className="divide-y divide-line sm:grid sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
        {ranked.map((person) => (
          <li
            key={person.id}
            className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 last:border-b-0 sm:border-b"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{person.name}</p>
              <p className="text-xs text-ink-subtle">
                {person.tiktok} TikTok · {person.ebay} eBay
              </p>
            </div>
            <span
              className={cn(
                "tabular shrink-0 text-lg font-semibold",
                person.shows === 0 ? "text-ink-subtle" : "text-ink",
              )}
            >
              {person.shows === 0 ? "—" : person.shows}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Who can be put on a show, and what to warn about if they are. */
export interface Candidate {
  userId: string;
  name: string;
  /** Set when picking them would be a clash — the option is disabled. */
  blocked: string | null;
  /** Set when picking them is allowed but worth flagging. */
  warn: string | null;
}

/**
 * Candidates for every empty seat, keyed `showId|seat`.
 *
 * Worked out on the server and passed as data rather than as a callback: a
 * function cannot cross the server/client boundary, and the checks behind it
 * need the whole week's shows, availability and time off.
 */
export type CandidateMap = Record<string, Candidate[]>;

function Submitting({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return <span className={cn(pending && "opacity-50")}>{children}</span>;
}

function IconSubmit({ label, icon }: { label: string; icon: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="sm"
      variant="ghost"
      disabled={pending}
      aria-label={label}
      title={label}
    >
      {icon}
    </Button>
  );
}

/**
 * One of the two people on a show.
 *
 * There is no job label: the pair split the show and swap halfway, so a seat is
 * just a place to put a name.
 */
function Seat({
  show,
  seat,
  candidates,
  disabled,
}: {
  show: BuilderShow;
  seat: BuilderSeat;
  candidates: Candidate[];
  disabled: boolean;
}) {
  const [assignState, assignAction] = useActionState<ActionState, FormData>(assignToShow, {});
  const [clearState, clearAction] = useActionState<ActionState, FormData>(clearSeat, {});
  const error = assignState.error ?? clearState.error;

  return (
    <div className="min-w-0">
      {seat.userId ? (
        <div className="flex items-center gap-1.5 rounded-lg bg-canvas px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
            {seat.userName}
          </span>
          {!disabled ? (
            <form action={clearAction}>
              <input type="hidden" name="showId" value={show.id} />
              <input type="hidden" name="seat" value={seat.seat} />
              <IconSubmit label={`Remove ${seat.userName}`} icon={<X className="h-3.5 w-3.5" />} />
            </form>
          ) : null}
        </div>
      ) : disabled ? (
        <p className="px-2 py-1.5 text-sm text-ink-subtle">—</p>
      ) : (
        <form action={assignAction}>
          <input type="hidden" name="showId" value={show.id} />
          <input type="hidden" name="seat" value={seat.seat} />
          <Select
            name="userId"
            defaultValue=""
            aria-label={`Person ${seat.seat} for ${show.platform} ${show.slot} on ${show.dateISO}`}
            className="h-8 text-sm"
            onChange={(e) => {
              if (e.target.value) e.target.form?.requestSubmit();
            }}
          >
            <option value="" disabled>
              Pick someone…
            </option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId} disabled={c.blocked !== null}>
                {c.name}
                {c.blocked ? ` — ${c.blocked}` : c.warn ? ` (${c.warn})` : ""}
              </option>
            ))}
          </Select>
        </form>
      )}

      {seat.flag ? <p className="mt-0.5 px-2 text-xs text-warn-700">{seat.flag}</p> : null}
      {error ? <p className="mt-0.5 px-2 text-xs font-medium text-danger-600">{error}</p> : null}
    </div>
  );
}

/** The inline hours editor, opened from the clock button on a show. */
function HoursEditor({ show, onDone }: { show: BuilderShow; onDone: () => void }) {
  const [state, action] = useActionState<ActionState, FormData>(updateShowHours, {});

  return (
    <form action={action} className="mt-2 space-y-2 rounded-lg border border-line bg-canvas p-2.5">
      <input type="hidden" name="showId" value={show.id} />
      <div className="flex items-center gap-2">
        <Input
          name="start"
          type="time"
          defaultValue={show.startHM}
          aria-label="Start time"
          className="h-8 text-sm"
          required
        />
        <span className="text-sm text-ink-subtle">to</span>
        <Input
          name="end"
          type="time"
          defaultValue={show.endHM}
          aria-label="End time"
          className="h-8 text-sm"
          required
        />
      </div>
      <p className="text-xs text-ink-subtle">
        An end time before the start means the show runs past midnight.
      </p>
      <div className="flex items-center gap-2">
        <Submitting>
          <Button type="submit" size="sm">
            Save hours
          </Button>
        </Submitting>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {state.error ? <p className="text-xs font-medium text-danger-600">{state.error}</p> : null}
      {state.ok ? <p className="text-xs font-medium text-ok-700">{state.ok}</p> : null}
    </form>
  );
}

function ShowCard({
  show,
  candidates,
  readOnly,
}: {
  show: BuilderShow;
  candidates: CandidateMap;
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [cancelState, cancelAction] = useActionState<ActionState, FormData>(toggleShowCancelled, {});

  const cancelled = show.status === "CANCELLED";
  const empty = show.seats.filter((s) => s.userId === null).length;

  return (
    <div
      className={cn(
        "rounded-xl border bg-surface p-3",
        cancelled
          ? "border-line bg-canvas opacity-70"
          : empty > 0
            ? "border-danger-200"
            : "border-line",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <PlatformBadge platform={show.platform} />
          <Badge tone={show.slot === "DAY" ? "warn" : "brand"}>{SLOT_SHORT[show.slot]}</Badge>
          {cancelled ? <Badge tone="neutral">Cancelled</Badge> : null}
        </div>

        {!readOnly ? (
          <div className="flex items-center gap-0.5">
            {!cancelled ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Change hours"
                title="Change hours"
                onClick={() => setEditing((v) => !v)}
              >
                <Clock className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            <form action={cancelAction}>
              <input type="hidden" name="showId" value={show.id} />
              <IconSubmit
                label={cancelled ? "Put this show back on" : "Cancel this show"}
                icon={
                  cancelled ? <RotateCcw className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />
                }
              />
            </form>
          </div>
        ) : null}
      </div>

      <p className="mt-1 text-sm text-ink-muted">
        {show.startHM}–{show.endHM}
        <span className="text-ink-subtle"> · {formatMinutes(show.minutes)}</span>
      </p>

      {editing && !readOnly ? <HoursEditor show={show} onDone={() => setEditing(false)} /> : null}

      {cancelled ? (
        <p className="mt-2 text-sm text-ink-muted">
          Not running{show.notes ? ` — ${show.notes}` : ""}.
        </p>
      ) : (
        <div className="mt-2.5 space-y-1.5">
          {show.seats.map((seat) => (
            <Seat
              key={seat.seat}
              show={show}
              seat={seat}
              candidates={candidates[seatKey(show.id, seat.seat)] ?? []}
              disabled={readOnly}
            />
          ))}
        </div>
      )}

      {cancelState.error ? (
        <p className="mt-1 text-xs font-medium text-danger-600">{cancelState.error}</p>
      ) : null}
    </div>
  );
}

export function ScheduleBuilder({
  dates,
  shows,
  people,
  candidates,
  readOnly = false,
}: {
  dates: DateISO[];
  shows: BuilderShow[];
  people: BuilderPerson[];
  candidates: CandidateMap;
  readOnly?: boolean;
}) {
  const [onlyGaps, setOnlyGaps] = useState(false);

  const byDate = useMemo(() => {
    const visible = onlyGaps
      ? shows.filter((s) => s.status === "SCHEDULED" && s.seats.some((seat) => !seat.userId))
      : shows;
    return dates.map((dateISO) => ({
      dateISO,
      shows: visible.filter((s) => s.dateISO === dateISO),
    }));
  }, [dates, shows, onlyGaps]);

  const gaps = shows.filter(
    (s) => s.status === "SCHEDULED" && s.seats.some((seat) => !seat.userId),
  ).length;

  return (
    <div className="space-y-4">
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={onlyGaps ? "primary" : "secondary"}
            onClick={() => setOnlyGaps((v) => !v)}
            disabled={gaps === 0 && !onlyGaps}
          >
            {onlyGaps ? "Showing only unfilled" : `Show only unfilled (${gaps})`}
          </Button>
          {people.length === 0 ? (
            <span className="text-sm text-ink-muted">
              No active streamers yet — add the team first.
            </span>
          ) : null}
        </div>
      ) : null}

      {people.length > 0 ? <PersonTally people={people} /> : null}

      {byDate.map(({ dateISO, shows: dayShows }) => (
        <Card key={dateISO}>
          <CardHeader
            title={formatDate(dateISO, "long")}
            description={
              dayShows.length === 0
                ? onlyGaps
                  ? "Everything filled."
                  : "No shows."
                : `${dayShows.filter((s) => s.status === "SCHEDULED").length} running`
            }
          />
          {dayShows.length > 0 ? (
            <div className="grid gap-3 p-3 sm:grid-cols-2 2xl:grid-cols-4">
              {dayShows.map((show) => (
                <ShowCard
                  key={show.id}
                  show={show}
                  candidates={candidates}
                  readOnly={readOnly}
                />
              ))}
            </div>
          ) : null}
        </Card>
      ))}

      {onlyGaps && byDate.every((d) => d.shows.length === 0) ? (
        <Alert tone="ok" title="Every show has two people">
          Nothing left to fill this period.
        </Alert>
      ) : null}
    </div>
  );
}

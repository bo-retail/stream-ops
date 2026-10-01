"use client";

import { Fragment, useActionState, useState } from "react";
import { Button, Card, CardHeader, Input, Table, Td, Th } from "@/components/ui";
import { formatMinutes } from "@/lib/domain/dates";
import { formatBps } from "@/lib/domain/payroll";
import { setPersonRate, setRates } from "./actions";

/**
 * The money half of the timesheet.
 *
 * Hours and pay are the same screen deliberately: the question "how much do we
 * owe" is never asked without also asking "for what hours", and two tabs would
 * mean two places to notice that somebody never clocked out.
 */

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

const BUSINESS_WORD = { WATCH: "watch", DIAMOND: "diamond" } as const;

export interface PayRow {
  userId: string;
  name: string;
  team: "STREAMING" | "SHIPPING";
  position: string;
  minutes: number;
  hourlyRateCents: number;
  /** Hours by the rate they were paid at; two lines for somebody on both kinds of show. */
  hourly: { business: "WATCH" | "DIAMOND"; minutes: number; rateCents: number }[];
  hourlyPayCents: number;
  commissionBps: number;
  commissionCents: number;
  totalCents: number;
  openShifts: number;
  unrated: boolean;
  shows: { label: string; netRevenueCents: number; commissionCents: number }[];
}

export function RatesPanel({
  streamerHourlyCents,
  diamondStreamerHourlyCents,
  shippingHourlyCents,
  commissionBps,
  diamondCommissionBps,
}: {
  /** A watch streamer's hour, and any streamer hour with no show attached. */
  streamerHourlyCents: number;
  /** A streamer's hour on a diamond show. */
  diamondStreamerHourlyCents: number;
  shippingHourlyCents: number;
  /** What a watch show pays each of its pair. */
  commissionBps: number;
  /** What a diamond show pays. Set apart because a piece is worth far more. */
  diamondCommissionBps: number;
}) {
  const [state, action, pending] = useActionState(setRates, {});
  /*
    What was last typed, so a refused save does not wipe it.

    React resets a form to its default values once its action finishes. With
    the saved rates as the defaults, one mistyped box sent every other figure
    the boss had just typed back to what it was. Remembering the submission and
    using it as the default makes the reset put back what they typed.

    Only while the save is refused. Once it goes through, the boxes show the
    saved rates again — otherwise this tab would keep showing what it typed
    after somebody else changed a rate, and its next save would quietly put
    their change back.
  */
  const [typed, setTyped] = useState<Record<string, string> | null>(null);
  const shown = (name: string, saved: string) =>
    (state.error ? typed?.[name] : undefined) ?? saved;

  return (
    <Card>
      <CardHeader
        title="What people are paid"
        description="Everyone earns hourly. A streamer earns their share of each show they were on, on top."
      />
      <form
        action={action}
        onSubmit={(e) => {
          const values: Record<string, string> = {};
          new FormData(e.currentTarget).forEach((v, k) => {
            if (typeof v === "string") values[k] = v;
          });
          setTyped(values);
        }}
        className="space-y-3 p-4"
      >
        {/*
          One block per kind of person, because that is how the question is
          asked: "what does a diamond streamer get?" is both its numbers side by
          side, not one from each of two lists.
        */}
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            Watch streamer
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">Per hour</span>
            <Input
              name="streamerHourly"
              defaultValue={shown("streamerHourly", dollars(streamerHourlyCents))}
              inputMode="decimal"
              aria-label="Watch streamer hourly rate in dollars"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">Commission, watch show</span>
            <Input
              name="commissionPercent"
              defaultValue={shown("commissionPercent", String(commissionBps / 100))}
              inputMode="decimal"
              aria-label="Watch show commission percentage"
            />
          </label>
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            Diamond streamer
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">Per hour</span>
            <Input
              name="diamondStreamerHourly"
              defaultValue={shown("diamondStreamerHourly", dollars(diamondStreamerHourlyCents))}
              inputMode="decimal"
              aria-label="Diamond streamer hourly rate in dollars"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">Commission, diamond show</span>
            <Input
              name="diamondCommissionPercent"
              defaultValue={shown("diamondCommissionPercent", String(diamondCommissionBps / 100))}
              inputMode="decimal"
              aria-label="Diamond show commission percentage"
            />
          </label>
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            Shipping
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">Per hour</span>
            <Input
              name="shippingHourly"
              defaultValue={shown("shippingHourly", dollars(shippingHourlyCents))}
              inputMode="decimal"
              aria-label="Shipping hourly rate in dollars"
            />
          </label>
          </div>
        </fieldset>

        <p className="text-xs text-ink-muted">
          Commission is a percentage of what that show sold, and <strong>both people on a show
          earn it separately</strong> — at 1% a show pays out 2% of its sales in total. The two are
          set apart because a diamond piece is worth several times a watch, so the same percentage
          is a very different amount of money. Changing a rate does not rewrite anything already
          paid out; it applies to this period and every one after it, and every change is on the
          log below.
        </p>

        <p className="text-xs text-ink-muted">
          A streamer&apos;s hours on a diamond show are paid the diamond rate; every other streamer
          hour — a watch show, or time clocked with no show — is paid the watch rate. Shipping have
          one rate whatever they pack. Somebody given their own hourly under Individual rates is
          paid it on both kinds of show.
        </p>

        {state.error ? <p className="text-sm font-medium text-danger-600">{state.error}</p> : null}
        {state.ok ? <p className="text-sm font-medium text-ok-700">{state.ok}</p> : null}

        <Button type="submit" disabled={pending} size="sm">
          {pending ? "Saving…" : "Save rates"}
        </Button>
      </form>
    </Card>
  );
}

/** One person's own rate, when it differs from their team's. */
export function PersonRates({
  people,
}: {
  people: {
    id: string;
    name: string;
    position: string;
    hourlyRateCents: number | null;
    commissionBps: number | null;
    team: "STREAMING" | "SHIPPING";
  }[];
}) {
  const [open, setOpen] = useState(false);
  const withOwn = people.filter((p) => p.hourlyRateCents !== null || p.commissionBps !== null);

  return (
    <Card>
      <CardHeader
        title="Individual rates"
        description={
          withOwn.length === 0
            ? "Everybody is on their team's rate."
            : `${withOwn.length} on a rate of their own.`
        }
        action={
          <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Set one"}
          </Button>
        }
      />
      {open ? (
        <Table>
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Per hour</Th>
              <Th>Commission</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <PersonRateRow key={p.id} person={p} />
            ))}
          </tbody>
        </Table>
      ) : withOwn.length > 0 ? (
        <ul className="divide-y divide-line">
          {withOwn.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <span className="font-medium text-ink">{p.name}</span>
              <span className="tabular text-ink-muted">
                {p.hourlyRateCents !== null ? `${money(p.hourlyRateCents)}/h` : "team rate"}
                {p.team === "STREAMING" && p.commissionBps !== null
                  ? ` · ${formatBps(p.commissionBps)}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function PersonRateRow({
  person,
}: {
  person: {
    id: string;
    name: string;
    position: string;
    hourlyRateCents: number | null;
    commissionBps: number | null;
    team: "STREAMING" | "SHIPPING";
  };
}) {
  const [state, action, pending] = useActionState(setPersonRate, {});

  return (
    <tr>
      <Td>
        <span className="font-medium text-ink">{person.name}</span>
        <span className="block text-xs text-ink-subtle">{person.position}</span>
        {state.error ? (
          <span className="block text-xs font-medium text-danger-600">{state.error}</span>
        ) : null}
        {state.ok ? <span className="block text-xs font-medium text-ok-700">{state.ok}</span> : null}
      </Td>
      <Td colSpan={3}>
        <form action={action} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="userId" value={person.id} />
          <Input
            name="hourly"
            className="h-9 w-28"
            placeholder="team rate"
            inputMode="decimal"
            defaultValue={person.hourlyRateCents === null ? "" : dollars(person.hourlyRateCents)}
            aria-label={`${person.name} hourly rate`}
          />
          <Input
            name="commissionPercent"
            className="h-9 w-28"
            placeholder={person.team === "SHIPPING" ? "n/a" : "standard"}
            inputMode="decimal"
            disabled={person.team === "SHIPPING"}
            defaultValue={person.commissionBps === null ? "" : String(person.commissionBps / 100)}
            aria-label={`${person.name} commission percentage`}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={pending}>
            {pending ? "…" : "Save"}
          </Button>
        </form>
      </Td>
    </tr>
  );
}

/** What each person is owed, and what it is made of. */
export function PayTable({ rows }: { rows: PayRow[] }) {
  const [openRow, setOpenRow] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader title="What is owed" />
        <p className="px-4 py-10 text-center text-sm text-ink-muted">
          Nobody worked or earned in this period.
        </p>
      </Card>
    );
  }

  const total = rows.reduce((n, r) => n + r.totalCents, 0);

  return (
    <Card>
      <CardHeader
        title="What is owed"
        description="Hours at each person's rate, plus commission on the shows they were on."
        action={<span className="tabular text-sm font-semibold text-ink">{money(total)}</span>}
      />
      <Table>
        <thead>
          <tr>
            <Th>Person</Th>
            <Th>Hours</Th>
            <Th>Rate</Th>
            <Th>Hourly pay</Th>
            <Th>Commission</Th>
            <Th>Total</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.userId}>
              <tr>
                <Td>
                  <span className="font-medium text-ink">{r.name}</span>
                  <span className="block text-xs text-ink-subtle">{r.position}</span>
                  {r.unrated ? (
                    <span className="block text-xs font-medium text-danger-600">
                      No rate set — this pays nothing
                    </span>
                  ) : null}
                  {r.openShifts > 0 ? (
                    <span className="block text-xs font-medium text-warn-700">
                      {r.openShifts} shift{r.openShifts === 1 ? "" : "s"} never clocked out
                    </span>
                  ) : null}
                </Td>
                <Td className="tabular">
                  {formatMinutes(r.minutes)}
                  {r.hourly.length > 1 || r.hourly[0]?.business === "DIAMOND"
                    ? r.hourly.map((l) => (
                        <span key={l.business} className="block text-xs text-ink-subtle">
                          {formatMinutes(l.minutes)} {BUSINESS_WORD[l.business]}
                        </span>
                      ))
                    : null}
                </Td>
                <Td className="tabular text-ink-muted">
                  {new Set(r.hourly.map((l) => l.rateCents)).size > 1 ? (
                    r.hourly.map((l) => (
                      <span key={l.business} className="block">
                        {money(l.rateCents)}/h
                        <span className="ml-1 text-xs text-ink-subtle">{BUSINESS_WORD[l.business]}</span>
                      </span>
                    ))
                  ) : (
                    <>{money(r.hourlyRateCents)}/h</>
                  )}
                </Td>
                <Td className="tabular">{money(r.hourlyPayCents)}</Td>
                <Td className="tabular">
                  {r.shows.length === 0 ? (
                    <span className="text-ink-subtle">—</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setOpenRow(openRow === r.userId ? null : r.userId)}
                      className="underline decoration-dotted underline-offset-2 hover:text-brand-700"
                    >
                      {money(r.commissionCents)}
                      <span className="ml-1 text-xs text-ink-subtle">
                        ({r.shows.length} show{r.shows.length === 1 ? "" : "s"} at{" "}
                        {formatBps(r.commissionBps)})
                      </span>
                    </button>
                  )}
                </Td>
                <Td className="tabular font-semibold">{money(r.totalCents)}</Td>
              </tr>
              {openRow === r.userId ? (
                <tr>
                  <Td colSpan={6} className="bg-canvas">
                    <ul className="space-y-1 text-xs">
                      {r.shows.map((s) => (
                        <li key={s.label} className="flex justify-between gap-3">
                          <span className="text-ink-muted">{s.label}</span>
                          <span className="tabular">
                            {money(s.netRevenueCents)} sold →{" "}
                            <strong className="text-ink">{money(s.commissionCents)}</strong>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

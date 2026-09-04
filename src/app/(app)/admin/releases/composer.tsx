"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Send, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardHeader, Input, Label, Select } from "@/components/ui";
import { formatDate } from "@/lib/domain/dates";
import { PLATFORM_SHORT, SLOT_SHORT, SUGGESTED_HOURS } from "@/lib/domain/types";
import type { DateISO, Platform, Slot } from "@/lib/domain/types";
import { deleteRelease, getDeleteImpact, setReleaseRules, setReleaseShows } from "./actions";
import type { DeleteImpact, ReleaseState } from "./actions";

/** The four shows that can exist on a day, in the order they appear as columns. */
const COLUMNS: { platform: Platform; slot: Slot; key: string }[] = [
  { platform: "TIKTOK", slot: "DAY", key: "TIKTOK|DAY" },
  { platform: "EBAY", slot: "DAY", key: "EBAY|DAY" },
  { platform: "TIKTOK", slot: "NIGHT", key: "TIKTOK|NIGHT" },
  { platform: "EBAY", slot: "NIGHT", key: "EBAY|NIGHT" },
];

export interface ExistingShow {
  dateISO: DateISO;
  platform: Platform;
  slot: Slot;
  startHM: string;
  endHM: string;
  staffed: boolean;
}

export interface Person {
  id: string;
  name: string;
}

const cellKey = (dateISO: string, platform: Platform, slot: Slot) =>
  `${dateISO}|${platform}|${slot}`;

/**
 * Composing a release: which days, which shows, what hours.
 *
 * A grid rather than a form per show. Twenty-eight days of four shows is a
 * hundred and twelve decisions, and the only way that is bearable is if the
 * common shapes — every day, weekdays, nights only — are one click, and the
 * exceptions are then ticked off by hand.
 */
export function Composer({
  releaseId,
  dates,
  existing,
  streamers,
  rules,
  editable,
}: {
  releaseId: string;
  dates: DateISO[];
  existing: ExistingShow[];
  streamers: Person[];
  rules: {
    usePriority: boolean;
    useProportional: boolean;
    maxShowsPerPerson: number | null;
    priorityUserIds: string[];
  };
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ReleaseState>({});

  // Hours are set per slot for the whole release; one-off changes to a single
  // show are made later on the schedule page, where the context is the show.
  const firstDay = existing.find((s) => s.slot === "DAY");
  const firstNight = existing.find((s) => s.slot === "NIGHT");
  const [dayStart, setDayStart] = useState(firstDay?.startHM ?? SUGGESTED_HOURS.DAY.start);
  const [dayEnd, setDayEnd] = useState(firstDay?.endHM ?? SUGGESTED_HOURS.DAY.end);
  const [nightStart, setNightStart] = useState(firstNight?.startHM ?? SUGGESTED_HOURS.NIGHT.start);
  const [nightEnd, setNightEnd] = useState(firstNight?.endHM ?? SUGGESTED_HOURS.NIGHT.end);

  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(existing.map((s) => cellKey(s.dateISO, s.platform, s.slot))),
  );

  const staffedKeys = useMemo(
    () =>
      new Set(
        existing.filter((s) => s.staffed).map((s) => cellKey(s.dateISO, s.platform, s.slot)),
      ),
    [existing],
  );

  const [usePriority, setUsePriority] = useState(rules.usePriority);
  const [useProportional, setUseProportional] = useState(rules.useProportional);
  const [cap, setCap] = useState(rules.maxShowsPerPerson?.toString() ?? "");
  const [priorityIds, setPriorityIds] = useState<string[]>(rules.priorityUserIds);

  function toggle(key: string) {
    if (!editable) return;
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function fill(which: "all" | "weekdays" | "days" | "nights" | "none") {
    if (!editable) return;
    const next = new Set<string>();
    if (which !== "none") {
      for (const date of dates) {
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        if (which === "weekdays" && (weekday === 0 || weekday === 6)) continue;
        for (const col of COLUMNS) {
          if (which === "days" && col.slot !== "DAY") continue;
          if (which === "nights" && col.slot !== "NIGHT") continue;
          next.add(cellKey(date, col.platform, col.slot));
        }
      }
    }
    // A show somebody is already scheduled on cannot be dropped by a quick fill.
    for (const key of staffedKeys) next.add(key);
    setTicked(next);
  }

  function saveShows() {
    const picks = [...ticked].map((key) => {
      const [dateISO, platform, slot] = key.split("|") as [DateISO, Platform, Slot];
      return {
        dateISO,
        platform,
        slot,
        startHM: slot === "DAY" ? dayStart : nightStart,
        endHM: slot === "DAY" ? dayEnd : nightEnd,
      };
    });
    startTransition(async () => {
      const result = await setReleaseShows(releaseId, picks);
      setState(result);
      if (result.ok) router.refresh();
    });
  }

  function saveRules() {
    startTransition(async () => {
      const result = await setReleaseRules(releaseId, {
        usePriority,
        useProportional,
        maxShowsPerPerson: cap.trim() === "" ? null : Number(cap),
        priorityUserIds: usePriority ? priorityIds : [],
      });
      setState(result);
      if (result.ok) router.refresh();
    });
  }

  const showCount = ticked.size;

  return (
    <div className="space-y-5">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="ok">{state.ok}</Alert> : null}

      <Card>
        <CardHeader
          title="Hours"
          description="What the day and night shows run in this release. One show can still be adjusted on its own afterwards."
        />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <div>
            <Label>Day shows</Label>
            <div className="flex items-center gap-2">
              <Input
                type="time"
                value={dayStart}
                disabled={!editable}
                onChange={(e) => setDayStart(e.target.value)}
                aria-label="Day show start"
              />
              <span className="text-sm text-ink-subtle">to</span>
              <Input
                type="time"
                value={dayEnd}
                disabled={!editable}
                onChange={(e) => setDayEnd(e.target.value)}
                aria-label="Day show end"
              />
            </div>
          </div>
          <div>
            <Label>Night shows</Label>
            <div className="flex items-center gap-2">
              <Input
                type="time"
                value={nightStart}
                disabled={!editable}
                onChange={(e) => setNightStart(e.target.value)}
                aria-label="Night show start"
              />
              <span className="text-sm text-ink-subtle">to</span>
              <Input
                type="time"
                value={nightEnd}
                disabled={!editable}
                onChange={(e) => setNightEnd(e.target.value)}
                aria-label="Night show end"
              />
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              An end earlier than the start runs past midnight, which is normal for a night show.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Which shows run"
          description={`Tick the shows this release is asking about. ${showCount} ticked.`}
          action={
            editable ? (
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["all", "All four, every day"],
                    ["weekdays", "Weekdays only"],
                    ["days", "Days only"],
                    ["nights", "Nights only"],
                    ["none", "Clear"],
                  ] as const
                ).map(([which, label]) => (
                  <Button
                    key={which}
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => fill(which)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            ) : null
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Day
                </th>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className="px-2 py-2 text-center text-xs font-medium uppercase tracking-wide text-ink-subtle"
                  >
                    {PLATFORM_SHORT[col.platform]}
                    <br />
                    {SLOT_SHORT[col.slot]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {dates.map((date) => {
                const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
                const weekend = weekday === 0 || weekday === 6;
                return (
                  <tr key={date} className={weekend ? "bg-canvas/60" : undefined}>
                    <td className="whitespace-nowrap px-4 py-1.5 font-medium text-ink">
                      {formatDate(date)}
                    </td>
                    {COLUMNS.map((col) => {
                      const key = cellKey(date, col.platform, col.slot);
                      const on = ticked.has(key);
                      const locked = staffedKeys.has(key);
                      return (
                        <td key={col.key} className="px-2 py-1.5 text-center">
                          <button
                            type="button"
                            disabled={!editable || locked}
                            onClick={() => toggle(key)}
                            aria-pressed={on}
                            aria-label={`${PLATFORM_SHORT[col.platform]} ${SLOT_SHORT[col.slot]} on ${date}`}
                            title={locked ? "Somebody is scheduled on this show" : undefined}
                            className={`h-7 w-12 rounded-md border text-xs font-medium transition-colors ${
                              on
                                ? "border-brand-500 bg-brand-500 text-white"
                                : "border-line-strong bg-surface text-ink-subtle hover:bg-canvas"
                            } ${!editable || locked ? "cursor-not-allowed opacity-70" : ""}`}
                          >
                            {on ? "On" : "—"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {editable ? (
          <div className="border-t border-line p-4">
            <Button type="button" onClick={saveShows} disabled={pending}>
              <Check className="h-4 w-4" aria-hidden />
              {pending ? "Saving…" : "Save the shows"}
            </Button>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Rules for this release"
          description="Set here, and nowhere else. Nothing carries over to the next one."
        />
        <div className="space-y-4 p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={useProportional}
              disabled={!editable}
              onChange={(e) => setUseProportional(e.target.checked)}
            />
            <span>
              <span className="text-sm font-medium text-ink">
                More availability, more work
              </span>
              <span className="block text-xs text-ink-muted">
                Shows are handed out in proportion to what each person offered. Offer three times
                as much, get roughly three times the shows. Off means an even spread regardless.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={usePriority}
              disabled={!editable}
              onChange={(e) => setUsePriority(e.target.checked)}
            />
            <span>
              <span className="text-sm font-medium text-ink">Give some people priority</span>
              <span className="block text-xs text-ink-muted">
                The people you name below get a seat before anyone else. It never puts somebody on
                a show they did not offer.
              </span>
            </span>
          </label>

          {usePriority ? (
            <div className="rounded-lg border border-line bg-canvas p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-subtle">
                Priority, best first
              </p>
              <div className="flex flex-wrap gap-1.5">
                {streamers.map((person) => {
                  const at = priorityIds.indexOf(person.id);
                  const on = at >= 0;
                  return (
                    <button
                      key={person.id}
                      type="button"
                      disabled={!editable}
                      onClick={() =>
                        setPriorityIds((prev) =>
                          prev.includes(person.id)
                            ? prev.filter((id) => id !== person.id)
                            : [...prev, person.id],
                        )
                      }
                      className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors ${
                        on
                          ? "bg-brand-600 text-white ring-brand-600"
                          : "bg-surface text-ink-muted ring-line-strong hover:bg-canvas"
                      }`}
                    >
                      {on ? `${at + 1}. ` : ""}
                      {person.name}
                    </button>
                  );
                })}
              </div>
              {priorityIds.length === 0 ? (
                <p className="mt-2 text-xs text-warn-700">
                  Nobody named yet — tap the people who should get work first.
                </p>
              ) : null}
            </div>
          ) : null}

          <div>
            <Label htmlFor="cap">Most shows one person may get</Label>
            <Input
              id="cap"
              type="number"
              min="1"
              max="200"
              value={cap}
              disabled={!editable}
              placeholder="No limit"
              className="w-40"
              onChange={(e) => setCap(e.target.value)}
            />
            <p className="mt-1 text-xs text-ink-muted">
              Leave blank for no limit. Going over it is a warning, not a block.
            </p>
          </div>

          {editable ? (
            <Button type="button" variant="secondary" onClick={saveRules} disabled={pending}>
              <Check className="h-4 w-4" aria-hidden />
              {pending ? "Saving…" : "Save the rules"}
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

/** Sending it out, closing it, and deleting a draft that never went anywhere. */
export function ReleaseControls({
  releaseId,
  status,
  showCount,
  onDeleted,
}: {
  releaseId: string;
  status: "DRAFT" | "OPEN" | "CLOSED";
  showCount: number;
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ReleaseState>({});

  function run(fn: () => Promise<ReleaseState>, thenGo?: string) {
    startTransition(async () => {
      const result = await fn();
      setState(result);
      if (result.ok) {
        if (thenGo) router.push(thenGo);
        else router.refresh();
        onDeleted?.();
      }
    });
  }

  return (
    <div className="space-y-3">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="ok">{state.ok}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {status === "DRAFT" ? (
          <form
            action={async (formData: FormData) => {
              const { sendRelease } = await import("./actions");
              const result = await sendRelease({}, formData);
              setState(result);
              if (result.ok) router.refresh();
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="releaseId" value={releaseId} />
            <div>
              <Label htmlFor="dueAt">Answers due by (optional)</Label>
              <Input id="dueAt" name="dueAt" type="date" className="w-44" />
            </div>
            <Button type="submit" disabled={pending || showCount === 0}>
              <Send className="h-4 w-4" aria-hidden />
              Send to the team
            </Button>
          </form>
        ) : null}

        {status === "OPEN" ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => run(async () => (await import("./actions")).closeRelease(releaseId))}
          >
            Stop taking answers
          </Button>
        ) : null}

        {status === "CLOSED" ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => run(async () => (await import("./actions")).reopenRelease(releaseId))}
          >
            Take answers again
          </Button>
        ) : null}

        <DeleteRelease releaseId={releaseId} disabled={pending} />
      </div>
      {status === "DRAFT" && showCount === 0 ? (
        <p className="text-xs text-warn-700">Add some shows before sending it out.</p>
      ) : null}
    </div>
  );
}

/**
 * Deleting a release, in two steps.
 *
 * The first press does not delete: it asks what would go and shows the answer.
 * A release carries the shows, the schedule on them and everybody's answers, and
 * none of that is obvious from a button — so it gets said out loud, with the
 * counts, before anything happens.
 */
function DeleteRelease({ releaseId, disabled }: { releaseId: string; disabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [impact, setImpact] = useState<DeleteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);

  function ask() {
    startTransition(async () => {
      const result = await getDeleteImpact(releaseId);
      if (!result) setError("That release no longer exists.");
      else setImpact(result);
    });
  }

  function confirm() {
    startTransition(async () => {
      const result = await deleteRelease(releaseId);
      if (result.error) {
        setError(result.error);
        setImpact(null);
        return;
      }
      router.push("/admin/releases");
      router.refresh();
    });
  }

  if (impact) {
    const lines = [
      `${impact.shows} show${impact.shows === 1 ? "" : "s"}`,
      `${impact.assignments} placement${impact.assignments === 1 ? "" : "s"}`,
      `${impact.availability} availability row${impact.availability === 1 ? "" : "s"}`,
      `${impact.submissions} answer${impact.submissions === 1 ? "" : "s"}`,
    ];
    return (
      <div className="w-full space-y-2 rounded-lg border border-danger-200 bg-danger-50 p-3">
        <p className="text-sm font-semibold text-danger-700">
          Delete {impact.label}?
        </p>
        <p className="text-sm text-danger-700">
          This also deletes {lines.join(", ")}. It cannot be undone.
        </p>
        {impact.published ? (
          <p className="text-sm font-medium text-danger-700">
            This schedule is published — the team can see it right now.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="danger" size="sm" disabled={pending} onClick={confirm}>
            <Trash2 className="h-4 w-4" aria-hidden />
            {pending ? "Deleting…" : "Yes, delete it"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => setImpact(null)}
          >
            Keep it
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Button type="button" variant="danger" disabled={disabled || pending} onClick={ask}>
        <Trash2 className="h-4 w-4" aria-hidden />
        {pending ? "Checking…" : "Delete release"}
      </Button>
      {error ? (
        <p className="w-full text-sm font-medium text-danger-600">{error}</p>
      ) : null}
    </>
  );
}

export function StatusBadge({ status }: { status: "DRAFT" | "OPEN" | "CLOSED" }) {
  if (status === "OPEN") return <Badge tone="ok">Out with the team</Badge>;
  if (status === "CLOSED") return <Badge tone="neutral">Closed</Badge>;
  return <Badge tone="warn">Draft</Badge>;
}

export { Select };

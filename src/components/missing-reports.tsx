"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { Alert } from "@/components/ui";
import { dismissMissingReport } from "@/app/(app)/sales-reports/dismiss-actions";
import { formatDate } from "@/lib/domain/dates";
import type { DateISO } from "@/lib/domain/types";

/**
 * "A show ran and its reports are not all in."
 *
 * Silent failure otherwise: with no report there are no boxes to pack, no sales
 * and no commission — and an empty screen looks much like a quiet day. The same
 * goes for a day loaded without one of its files, which used to read as done:
 * 09/11 had its TikTok exports and no eBay one.
 *
 * Each day can be cleared off this list, because some of them are never going
 * to be resolved — a show that did not really run, a report that is not coming
 * — and a warning nobody can clear is one people learn to scroll past. Then the
 * one that matters goes with it.
 *
 * Clearing settles a to-do and nothing else. Sales report entry still lists the
 * day as missing and says who cleared it, and the day's data is untouched.
 * Packers never see any of this, because they cannot act on it.
 */
export function MissingReports({
  days,
  canDismiss,
}: {
  days: { dateISO: DateISO; missing: string }[];
  /** Packers see the warning but cannot clear it; it is not theirs to settle. */
  canDismiss: boolean;
}) {
  // Cleared rows go immediately rather than waiting for the server, so a long
  // backlog can be worked through without the list jumping under the cursor.
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  const showing = days.filter((d) => !cleared.has(d.dateISO));
  if (showing.length === 0) return null;

  function clear(dateISO: string) {
    setCleared((prev) => new Set(prev).add(dateISO));
    start(async () => {
      const result = await dismissMissingReport(dateISO);
      // Put it back if the server refused, rather than leaving somebody
      // believing they had dealt with it.
      if (result.error) {
        setCleared((prev) => {
          const next = new Set(prev);
          next.delete(dateISO);
          return next;
        });
      }
    });
  }

  const partial = showing.some((d) => d.missing !== "no report");

  return (
    <Alert
      tone="warn"
      title={
        showing.length === 1
          ? "A day is missing sales reports"
          : `${showing.length} days are missing sales reports`
      }
    >
      <p>
        {showing.length === 1 ? "This day ran shows" : "These days ran shows"} but not everything
        has been loaded — whatever is missing has nothing to pack against and no sales recorded:
      </p>
      <ul className="mt-2 space-y-0.5">
        {showing.map((day) => (
          <li key={day.dateISO} className="flex items-baseline gap-2 text-sm text-ink">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{formatDate(day.dateISO, "long")}</span>
              <span className="text-ink-muted">
                {" — "}
                {day.missing === "no report" ? "no report loaded" : `missing ${day.missing}`}
              </span>
            </span>
            {canDismiss ? (
              <button
                type="button"
                onClick={() => clear(day.dateISO)}
                disabled={pending}
                title={`Clear ${formatDate(day.dateISO, "long")} off the dashboard`}
                aria-label={`Clear ${formatDate(day.dateISO, "long")} off the dashboard`}
                className="shrink-0 rounded p-0.5 text-ink-subtle transition-colors hover:bg-warn-100 hover:text-ink disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {partial ? (
        <p className="mt-2">
          Each file goes up on its own — upload whichever is missing and the rest are left exactly
          as they are.
        </p>
      ) : null}
      <p className="mt-2">
        <Link
          href="/sales-reports"
          className="font-medium text-brand-700 underline underline-offset-2"
        >
          Upload them on Sales report entry
        </Link>
      </p>
    </Alert>
  );
}

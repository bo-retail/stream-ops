"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreMissingReport } from "./dismiss-actions";
import { formatDate } from "@/lib/domain/dates";

/**
 * "Somebody took this day off the dashboard" — said on the one page that still
 * shows it.
 *
 * Clearing a day settles a to-do; it does not load a report. So this page, which
 * is the record of what has actually come in, keeps listing the day as missing
 * and names whoever decided it was not coming. Without the name the day would
 * simply stop being chased with no trace of who stopped chasing it.
 *
 * Putting it back is one click, because the usual reason to look here is that
 * the report turned up after all.
 */
export function RestoreReport({
  dateISO,
  byName,
}: {
  dateISO: string;
  /** Null once the account that cleared it has been deleted. */
  byName: string | null;
}) {
  const [gone, setGone] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  if (gone) return null;

  return (
    <p className="mt-1 text-xs text-ink-subtle">
      cleared off the dashboard{byName ? ` by ${byName.split(" ")[0]}` : ""}
      {" · "}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await restoreMissingReport(dateISO);
            if (!result.error) {
              setGone(true);
              router.refresh();
            }
          })
        }
        title={`Put ${formatDate(dateISO, "long")} back on the dashboard`}
        className="font-medium underline underline-offset-2 hover:text-ink disabled:opacity-50"
      >
        {pending ? "putting it back…" : "put it back"}
      </button>
    </p>
  );
}

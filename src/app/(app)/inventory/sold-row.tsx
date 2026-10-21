"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Td } from "@/components/ui";
import { formatDate } from "@/lib/domain/dates";
import type { SoldAtShow } from "@/lib/domain/inventory";
import { soldShowsOf } from "./actions";

/**
 * One model's row on the Inventory page. Pressing the model opens a line
 * beneath it saying when it sold, show by show (Samuel, 10/21). The list is
 * read only when it is first opened, so the page does not wait on ~500 of them.
 */
export function SoldRow({
  model,
  columns,
  picture,
  children,
}: {
  model: string;
  /** How many columns the table has, for the line beneath. */
  columns: number;
  picture: React.ReactNode;
  /** The rest of the row's cells, after the model. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [shows, setShows] = useState<SoldAtShow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();

  function toggle() {
    const opening = !open;
    setOpen(opening);
    // Read again each time it opens: an upload since can have changed it.
    if (opening) {
      setError(null);
      startLoading(async () => {
        try {
          const r = await soldShowsOf(model);
          if (r.error) setError(r.error);
          else setShows(r.shows ?? []);
        } catch {
          setError("Could not load the sales just now. Reload the page and try again.");
        }
      });
    }
  }

  const total = shows?.reduce((n, s) => n + s.sold, 0) ?? 0;
  return (
    <>
      <tr className={open ? "bg-canvas" : undefined}>
        {picture}
        <Td className="truncate px-2 font-medium" title={model}>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="inline-flex max-w-full items-center gap-0.5 text-left tabular hover:underline"
          >
            {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />}
            <span className="truncate">{model}</span>
          </button>
        </Td>
        {children}
      </tr>
      {open ? (
        <tr className="bg-canvas">
          <td colSpan={columns} className="border-b border-line px-4 py-2 pl-16 text-sm">
            {error ? (
              <p className="text-danger-600">{error}</p>
            ) : shows === null || loading ? (
              <p className="text-ink-muted">Loading…</p>
            ) : shows.length === 0 ? (
              <p className="text-ink-muted">Not sold since inventory started.</p>
            ) : (
              <>
                <p className="mb-1 text-xs text-ink-muted">
                  {total} sold since inventory started, by show:
                </p>
                <ul className="max-h-64 space-y-0.5 overflow-y-auto tabular">
                  {shows.map((s) => (
                    <li key={`${s.day}|${s.show}`}>
                      <span className="inline-block w-24">{formatDate(s.day)}</span>
                      <span className="inline-block w-36 text-ink-muted">{s.show}</span>
                      <span className="font-medium">{s.sold} sold</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

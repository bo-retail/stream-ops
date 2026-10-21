"use client";

import { useMemo, useState } from "react";
import { Table, Td, Th } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface SortColumn {
  label: string;
  align?: "left" | "right";
  /** False for a column that does not sort (a picture, say). */
  sortable?: boolean;
  title?: string;
}

export interface SortRow {
  key: string;
  /** What each column shows, already drawn by the page. */
  cells: React.ReactNode[];
  /** What each column sorts by: a number, a word, or null (always last). */
  sort: (number | string | null)[];
}

/** Rows in column `by`'s order: highest first when `desc`; blanks always last. */
export function sortRows<R extends Pick<SortRow, "sort">>(rows: R[], by: number | null, desc: boolean): R[] {
  if (by === null) return rows;
  return [...rows].sort((a, b) => {
    const x = a.sort[by];
    const y = b.sort[by];
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return desc ? -c : c;
  });
}

/**
 * A table whose headings sort it, the way Excel does (Samuel, 21 October):
 * click a heading for highest first, click again for lowest first. Blanks stay
 * at the bottom either way. With `limit`, only the first rows show until
 * "Show all" — the sort still ranks every row, not just the ones shown.
 */
export function SortableTable({
  columns,
  rows,
  initial,
  limit,
}: {
  columns: SortColumn[];
  rows: SortRow[];
  /** The column it opens sorted by, highest first; none keeps the given order. */
  initial?: number;
  limit?: number;
}) {
  const [by, setBy] = useState<number | null>(initial ?? null);
  const [desc, setDesc] = useState(true);
  const [all, setAll] = useState(false);

  const sorted = useMemo(() => sortRows(rows, by, desc), [rows, by, desc]);

  const shown = limit && !all ? sorted.slice(0, limit) : sorted;

  const click = (i: number) => {
    if (by === i) setDesc(!desc);
    else {
      setBy(i);
      // Words read A to Z first; numbers highest first.
      setDesc(typeof rows.find((r) => r.sort[i] !== null)?.sort[i] === "number");
    }
  };

  return (
    <>
      <Table>
        <thead>
          <tr>
            {columns.map((c, i) => {
              const sortable = c.sortable !== false;
              const active = by === i;
              return (
                <Th
                  key={c.label || i}
                  className={cn(c.align === "right" && "text-right")}
                  title={c.title}
                  aria-sort={active ? (desc ? "descending" : "ascending") : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => click(i)}
                      className={cn(
                        "inline-flex items-center gap-1 hover:text-ink",
                        c.align === "right" && "flex-row-reverse",
                        active && "text-ink",
                      )}
                    >
                      {c.label}
                      <span aria-hidden className={cn("text-[10px]", !active && "opacity-30")}>
                        {active ? (desc ? "▼" : "▲") : "▼"}
                      </span>
                    </button>
                  ) : (
                    c.label
                  )}
                </Th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key}>
              {r.cells.map((cell, i) => (
                <Td key={i} className={cn(columns[i]?.align === "right" && "text-right")}>
                  {cell}
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
      {limit && rows.length > limit ? (
        <div className="px-4 py-2.5">
          <button type="button" onClick={() => setAll(!all)} className="text-sm font-medium text-brand-700 hover:underline">
            {all ? `Show the top ${limit}` : `Show all ${rows.length.toLocaleString("en-US")}`}
          </button>
        </div>
      ) : null}
    </>
  );
}

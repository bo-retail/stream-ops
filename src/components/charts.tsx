import { formatDate } from "@/lib/domain/dates";
import { movingAverage } from "@/lib/domain/insights";
import type { DateISO } from "@/lib/domain/types";

/**
 * Charts as inline SVG, rendered on the server.
 *
 * No charting library. Everything else here renders on the server with no
 * client data layer, and one dependency that only draws bars would drag a
 * hydration boundary and a few hundred kilobytes through every page that shows
 * a figure. These are a few dozen lines, they print, and they work with
 * JavaScript switched off.
 *
 * Colours come from the same tokens the badges use, so a TikTok bar is the
 * TikTok black and an eBay bar is the eBay blue wherever it appears.
 */

export const SERIES = {
  brand: "var(--color-brand-600, #3f49b8)",
  tiktok: "#0f172a",
  ebay: "#2563eb",
  muted: "var(--color-line-strong, #cbd2dd)",
} as const;

export interface BarPoint {
  dateISO: DateISO;
  value: number;
}

/**
 * Daily bars with a trend line over them.
 *
 * The bars are the truth — some days run four shows and some run two — and the
 * line is what the eye should follow. Without the line a real week looks like
 * chaos; without the bars the line hides the days nothing ran.
 */
export function DailyBars({
  points,
  height = 180,
  format,
  trendWindow = 7,
}: {
  points: BarPoint[];
  height?: number;
  format: (value: number) => string;
  trendWindow?: number;
}) {
  if (points.length === 0) return null;

  const width = Math.max(320, points.length * 14);
  const pad = { top: 12, right: 8, bottom: 22, left: 8 };
  const plotH = height - pad.top - pad.bottom;
  const plotW = width - pad.left - pad.right;

  const max = Math.max(...points.map((p) => p.value), 1);
  const barW = Math.max(2, (plotW / points.length) * 0.68);
  const step = plotW / points.length;

  const x = (i: number) => pad.left + i * step + (step - barW) / 2;
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;

  const trend = movingAverage(points, Math.min(trendWindow, Math.max(2, Math.floor(points.length / 3))));
  const line = trend
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(pad.left + i * step + step / 2).toFixed(1)} ${y(p.value).toFixed(1)}`)
    .join(" ");

  // A label every so often, so the axis stays readable at any range length.
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const peak = points.reduce((best, p) => (p.value > best.value ? p : best), points[0]);

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={`Daily figures from ${points[0].dateISO} to ${points[points.length - 1].dateISO}. Highest was ${format(peak.value)} on ${peak.dateISO}.`}
          className="block min-w-full"
        >
          {points.map((p, i) => (
            <g key={p.dateISO}>
              <rect
                x={x(i)}
                y={y(p.value)}
                width={barW}
                height={Math.max(p.value > 0 ? 1.5 : 0, pad.top + plotH - y(p.value))}
                rx={1.5}
                fill={p.value === 0 ? SERIES.muted : SERIES.brand}
                opacity={p.value === 0 ? 0.35 : 0.85}
              >
                <title>{`${formatDate(p.dateISO)} — ${format(p.value)}`}</title>
              </rect>
              {i % labelEvery === 0 ? (
                <text
                  x={pad.left + i * step + step / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-ink-subtle"
                  style={{ fontSize: 9 }}
                >
                  {p.dateISO.slice(5).replace("-", "/")}
                </text>
              ) : null}
            </g>
          ))}
          {points.length > 3 ? (
            <path d={line} fill="none" stroke={SERIES.brand} strokeWidth={1.75} opacity={0.55} />
          ) : null}
        </svg>
      </div>
      <figcaption className="mt-1 text-xs text-ink-subtle">
        Bars are each day. The line is a rolling average — a day with four shows against a day with
        two says nothing on its own.
      </figcaption>
    </figure>
  );
}

export interface SplitSlice {
  label: string;
  value: number;
  units: number;
  color: string;
}

/**
 * Two or three things, side by side, as one bar.
 *
 * A pie would need a legend and a protractor. A single stacked bar with the
 * figures written on it answers "which one earns" at a glance, which is the
 * only question being asked.
 */
export function SplitBar({
  slices,
  format,
}: {
  slices: SplitSlice[];
  format: (value: number) => string;
}) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  if (total === 0) return null;

  return (
    <div className="space-y-2.5">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-canvas" role="img" aria-label={slices.map((s) => `${s.label} ${format(s.value)}`).join(", ")}>
        {slices.map((s) => (
          <div
            key={s.label}
            style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }}
            title={`${s.label} — ${format(s.value)}`}
          />
        ))}
      </div>
      <ul className="space-y-1.5">
        {slices.map((s) => (
          <li key={s.label} className="flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-2 text-sm text-ink">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
                aria-hidden
              />
              {s.label}
            </span>
            <span className="tabular text-sm">
              <span className="font-semibold text-ink">{format(s.value)}</span>
              <span className="text-ink-subtle">
                {" "}
                · {s.units} watch{s.units === 1 ? "" : "es"} · {Math.round((s.value / total) * 100)}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

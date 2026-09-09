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
  height = 210,
  format,
  trendWindow = 7,
}: {
  points: BarPoint[];
  height?: number;
  format: (value: number) => string;
  trendWindow?: number;
}) {
  if (points.length === 0) return null;

  const width = Math.max(360, points.length * 16);
  const pad = { top: 22, right: 10, bottom: 24, left: 10 };
  const plotH = height - pad.top - pad.bottom;
  const plotW = width - pad.left - pad.right;

  const max = Math.max(...points.map((p) => p.value), 1);
  // Capped, so a one-day range is a bar rather than a block filling the card.
  const barW = Math.min(30, Math.max(2, (plotW / points.length) * 0.68));
  const step = plotW / points.length;

  const x = (i: number) => pad.left + i * step + (step - barW) / 2;
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;
  const baseline = pad.top + plotH;

  const trend = movingAverage(points, Math.min(trendWindow, Math.max(2, Math.floor(points.length / 3))));
  const line = trend
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(pad.left + i * step + step / 2).toFixed(1)} ${y(p.value).toFixed(1)}`)
    .join(" ");

  // A label every so often, so the axis stays readable at any range length.
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const peak = points.reduce((best, p) => (p.value > best.value ? p : best), points[0]);

  return (
    <figure className="m-0">
      <div className="scroll-x">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={`Daily figures from ${points[0].dateISO} to ${points[points.length - 1].dateISO}. Highest was ${format(peak.value)} on ${peak.dateISO}.`}
          className="block min-w-full"
        >
          <defs>
            <linearGradient id="bar-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES.brand} stopOpacity={0.95} />
              <stop offset="100%" stopColor={SERIES.brand} stopOpacity={0.62} />
            </linearGradient>
          </defs>

          {/* The scale, so a bar's height is readable as a figure rather than
              only as "taller than that one". */}
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={y(max)}
            y2={y(max)}
            stroke="var(--color-line)"
            strokeDasharray="3 4"
          />
          <text x={pad.left} y={y(max) - 6} className="fill-ink-subtle" style={{ fontSize: 9 }}>
            {format(max)}
          </text>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={baseline}
            y2={baseline}
            stroke="var(--color-line-strong)"
          />

          {points.map((p, i) => (
            <g key={p.dateISO}>
              <rect
                x={x(i)}
                y={y(p.value)}
                width={barW}
                height={Math.max(p.value > 0 ? 2 : 0, baseline - y(p.value))}
                rx={2}
                fill={p.value === 0 ? SERIES.muted : "url(#bar-fill)"}
                opacity={p.value === 0 ? 0.3 : 1}
              >
                <title>{`${formatDate(p.dateISO)} — ${format(p.value)}`}</title>
              </rect>
              {i % labelEvery === 0 ? (
                <text
                  x={pad.left + i * step + step / 2}
                  y={height - 7}
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
            <path
              d={line}
              fill="none"
              stroke={SERIES.brand}
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.5}
            />
          ) : null}
        </svg>
      </div>
      {points.length > 3 ? (
        <figcaption className="mt-1.5 text-xs text-ink-subtle">
          Bars are each day. The line is a rolling average — a day with four shows against a day
          with two says nothing on its own.
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * A bar inside a table row.
 *
 * A column of numbers tells you the order; it does not tell you whether the
 * best seller sold twice what the next one did or a tenth more. This is the
 * cheapest way to put that in the same glance.
 */
export function MiniBar({
  value,
  max,
  color = SERIES.brand,
}: {
  value: number;
  max: number;
  color?: string;
}) {
  const percent = max <= 0 ? 0 : Math.max(3, (value / max) * 100);
  return (
    <span
      className="inline-block h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-line align-middle sm:w-24"
      aria-hidden
    >
      <span
        className="block h-full rounded-full"
        style={{ width: `${percent}%`, backgroundColor: color }}
      />
    </span>
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
    <div className="space-y-3">
      <div
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-line"
        role="img"
        aria-label={slices.map((s) => `${s.label} ${format(s.value)}`).join(", ")}
      >
        {slices.map((s) => (
          <div
            key={s.label}
            className="first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }}
            title={`${s.label} — ${format(s.value)}`}
          />
        ))}
      </div>
      <ul className="space-y-2">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
                aria-hidden
              />
              <span className="truncate font-medium text-ink">{s.label}</span>
              <span className="tabular shrink-0 rounded-full bg-canvas px-1.5 py-0.5 text-xs font-medium text-ink-muted">
                {Math.round((s.value / total) * 100)}%
              </span>
            </span>
            <span className="tabular shrink-0 text-sm">
              <span className="font-semibold text-ink">{format(s.value)}</span>
              <span className="text-ink-subtle">
                {" "}
                · {s.units} watch{s.units === 1 ? "" : "es"}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

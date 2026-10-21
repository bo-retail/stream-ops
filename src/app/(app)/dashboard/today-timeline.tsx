import { BUSINESS_SHORT } from "@/lib/domain/business";
import type { Business } from "@/lib/domain/business";
import { PLATFORM_SHORT, slotShort } from "@/lib/domain/types";
import type { Platform, Slot } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export interface TimelineShow {
  id: string;
  business: Business;
  platform: Platform;
  slot: Slot;
  startHM: string;
  endHM: string;
  live: boolean;
  done: boolean;
  short: boolean;
  seatsMissing: number;
  names: string[];
}

/**
 * "TikTok Day", "eBay Night", "TikTok Early AM". An extra show's name may
 * already start with its platform ("TIKTOK EARLY AM"), which would otherwise
 * read "TikTok TIKTOK EARLY AM".
 */
export function showName(platform: Platform, slot: Slot): string {
  const p = PLATFORM_SHORT[platform];
  const s = slotShort(slot);
  // Only a whole leading word: "EBAYS PICKS" keeps its name, a bare "TIKTOK" keeps itself.
  const P = p.toUpperCase();
  const stripped = s.toUpperCase().startsWith(`${P} `) ? s.slice(p.length).trim() : s;
  const rest = stripped === "" || s.toUpperCase() === P ? s : stripped;
  const pretty = rest === rest.toUpperCase() ? rest.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(Am|Pm)\b/g, (x) => x.toUpperCase()) : rest;
  return `${p} ${pretty}`;
}

const minutes = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Today's shows drawn against the clock, with a brass hand at "now".
 *
 * A picture of the list under it, not a replacement: every fact here is also
 * written out below, so a phone too narrow to read a bar loses nothing. A night
 * show runs past midnight, so the day is measured from the first start and an
 * end earlier than its start is read as the next morning.
 *
 * "Now" is never wrapped past midnight: the shows are today's by calendar date,
 * so at 00:30 they are all still to come (last night's show belongs to
 * yesterday's list), and the hand stays off the strip until the first starts.
 */
export function TodayTimeline({ shows, nowHM }: { shows: TimelineShow[]; nowHM: string }) {
  if (shows.length === 0) return null;

  const spans = shows.map((s) => {
    const start = minutes(s.startHM);
    let end = minutes(s.endHM);
    if (end <= start) end += 24 * 60;
    return { show: s, start, end };
  });
  const from = Math.floor(Math.min(...spans.map((s) => s.start)) / 60) * 60;
  const to = Math.max(from + 60, Math.ceil(Math.max(...spans.map((s) => s.end)) / 60) * 60);
  const length = to - from;
  const at = (m: number) => ((m - from) / length) * 100;

  const now = minutes(nowHM);
  const showNow = now >= from && now <= to;

  // A tick every hour, a label every few, so the ruler reads at any span.
  const hours = length / 60;
  const labelEvery = hours <= 8 ? 2 : hours <= 14 ? 3 : 6;
  const ticks = Array.from({ length: hours + 1 }, (_, i) => from + i * 60);
  const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:00`;

  return (
    <div className="border-b border-line px-4 pb-4 pt-2 sm:px-5" aria-hidden>
      <div className="grid grid-cols-[4.5rem_1fr] sm:grid-cols-[5.5rem_1fr]">
        <span />
        <div className="relative h-5 text-[11px] text-ink-subtle tabular">
          {ticks.map((m, i) =>
            i % labelEvery === 0 ? (
              <span
                key={m}
                className={cn(
                  "absolute top-0",
                  i === 0 ? "" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
                )}
                style={{ left: `${at(m)}%` }}
              >
                {hm(m)}
              </span>
            ) : null,
          )}
        </div>
      </div>

      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-[4.5rem] right-0 sm:left-[5.5rem]">
          {ticks.map((m) => (
            <span key={m} className="absolute inset-y-0 w-px bg-line" style={{ left: `${at(m)}%` }} />
          ))}
          {showNow ? (
            <span
              className="absolute -top-1 bottom-0 z-10 w-0.5 -translate-x-1/2 rounded-full bg-brass"
              style={{ left: `${at(now)}%` }}
            >
              <span className="absolute -top-[22px] left-1/2 -translate-x-1/2 rounded bg-brass px-1 text-[11px] font-bold leading-4 text-white tabular">
                {nowHM}
              </span>
            </span>
          ) : null}
        </div>

        <div className="space-y-1.5 pt-1.5">
          {spans.map(({ show, start, end }) => (
            <div key={show.id} className="grid grid-cols-[4.5rem_1fr] items-center sm:grid-cols-[5.5rem_1fr]">
              <span className="truncate text-xs font-medium text-ink-muted">{BUSINESS_SHORT[show.business]}</span>
              <div className="relative h-9">
                {/* No hover card: full width, the bars show their names whole
                    (Samuel, 21 October). */}
                <div
                  className={cn(
                    "absolute inset-y-0 flex min-w-0 flex-col justify-center overflow-hidden rounded-lg px-2.5 text-xs leading-tight",
                    show.short
                      ? "bg-danger-50 text-danger-700 ring-2 ring-inset ring-danger-500"
                      : show.live
                        ? "bg-dial text-white"
                        : show.done
                          ? "bg-brand-50 text-ink-subtle"
                          : "bg-surface text-ink ring-1 ring-inset ring-line-strong",
                  )}
                  style={{ left: `${at(start)}%`, width: `calc(${at(end) - at(start)}% - 2px)` }}
                >
                  <span className="truncate font-semibold">
                    {showName(show.platform, show.slot)}
                    {show.short
                      ? ` · ${show.seatsMissing === 1 ? "Seat missing" : `${show.seatsMissing} seats missing`}`
                      : show.live
                        ? " · on air"
                        : ""}
                  </span>
                  <span className="truncate opacity-80">
                    {show.names.length === 0 ? "Nobody on it" : show.names.join(" and ")}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

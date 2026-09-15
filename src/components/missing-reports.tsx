import Link from "next/link";
import { Alert } from "@/components/ui";
import { formatDate } from "@/lib/domain/dates";
import type { DateISO } from "@/lib/domain/types";

/**
 * "A show ran and its reports are not all in."
 *
 * Silent failure otherwise: with no report there are no boxes to pack, no sales
 * and no commission — and an empty screen looks much like a quiet day. The same
 * goes for a day loaded without one marketplace's file, which used to read as
 * done: 09/11 had its TikTok exports and no eBay one.
 *
 * It does not dismiss. It goes when the report is uploaded, which is the point.
 * Packers never see it, because they cannot act on it.
 */
export function MissingReports({ days }: { days: { dateISO: DateISO; missing: string }[] }) {
  if (days.length === 0) return null;

  const partial = days.some((d) => d.missing !== "no report");

  return (
    <Alert tone="warn" title={days.length === 1 ? "A day is missing sales reports" : `${days.length} days are missing sales reports`}>
      <p>
        {days.length === 1 ? "This day ran shows" : "These days ran shows"} but not everything has
        been loaded — whatever is missing has nothing to pack against and no sales recorded:
      </p>
      <ul className="mt-2 space-y-0.5">
        {days.map((day) => (
          <li key={day.dateISO} className="text-sm text-ink">
            <span className="font-medium">{formatDate(day.dateISO, "long")}</span>
            <span className="text-ink-muted">
              {" — "}
              {day.missing === "no report" ? "no report loaded" : `missing ${day.missing}`}
            </span>
          </li>
        ))}
      </ul>
      {partial ? (
        <p className="mt-2">
          Upload <strong>all</strong> of that day&rsquo;s files together. A new upload replaces the
          day&rsquo;s report, so uploading only the missing file is refused.
        </p>
      ) : null}
      <p className="mt-2">
        <Link href="/sales-reports" className="font-medium text-brand-700 underline underline-offset-2">
          Upload them on Sales report entry
        </Link>
      </p>
    </Alert>
  );
}

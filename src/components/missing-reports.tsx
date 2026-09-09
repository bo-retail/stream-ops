import Link from "next/link";
import { Alert } from "@/components/ui";
import { formatDate } from "@/lib/domain/dates";
import type { DateISO } from "@/lib/domain/types";

/**
 * "A show ran and nobody uploaded its reports."
 *
 * Silent failure otherwise: with no report there are no boxes to pack, no sales
 * and no commission — and an empty screen looks much like a quiet day.
 *
 * It does not dismiss. It goes when the report is uploaded, which is the point.
 * Packers never see it, because they cannot act on it.
 */
export function MissingReports({ days }: { days: DateISO[] }) {
  if (days.length === 0) return null;

  return (
    <Alert tone="warn" title={days.length === 1 ? "A day is missing its sales report" : `${days.length} days are missing their sales reports`}>
      <p>
        {days.length === 1 ? "This day ran shows" : "These days ran shows"} but no report has
        been loaded, so there is nothing to pack against and no sales recorded:
      </p>
      <ul className="mt-2 space-y-0.5">
        {days.map((day) => (
          <li key={day} className="text-sm font-medium text-ink">
            {formatDate(day, "long")}
          </li>
        ))}
      </ul>
      <p className="mt-2">
        <Link href="/sales-reports" className="font-medium text-brand-700 underline underline-offset-2">
          Upload them on Sales report entry
        </Link>
      </p>
    </Alert>
  );
}

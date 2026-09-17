-- A missing-report day somebody has taken off the dashboard.
--
-- The dashboard is a list of things needing attention now. A day that has been
-- dealt with some other way — a show that never really ran, a report that is
-- not coming — sits on it forever otherwise, and a banner nobody can clear is a
-- banner people stop reading. Then the one that matters goes unread too.
--
-- Clearing hides the day from the dashboard and nowhere else. Sales report
-- entry still lists it as missing and says who cleared it, because that page is
-- the record of what has actually been loaded rather than a to-do list. No
-- sales, boxes or figures are touched by this at all.
--
-- Keyed by the date, so clearing one clears it for the whole team: it is a
-- shared job, and one person settling it should settle it for everybody.
--
-- Purely additive: one new table, nothing else touched, safe to run twice.

CREATE TABLE IF NOT EXISTS "DismissedReport" (
    "showDate" DATE NOT NULL,
    "dismissedById" TEXT,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DismissedReport_pkey" PRIMARY KEY ("showDate")
);

-- SetNull, not Cascade: deleting somebody's account must not quietly bring a
-- cleared day back onto everybody's dashboard months later.
DO $$ BEGIN
  ALTER TABLE "DismissedReport"
    ADD CONSTRAINT "DismissedReport_dismissedById_fkey" FOREIGN KEY ("dismissedById")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

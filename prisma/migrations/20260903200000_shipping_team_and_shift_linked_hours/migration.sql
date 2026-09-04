-- Two changes:
--
--   1. People belong to a team. Streamers are scheduled and their hours are
--      measured against the show they were on; shipping has no schedule and
--      their clocked hours count exactly as clocked.
--   2. A time entry can name the show it is measured against. The raw clock
--      times are never altered — the link is what lets the paid window be
--      derived from them.

CREATE TYPE "Team" AS ENUM ('STREAMING', 'SHIPPING');

ALTER TABLE "User" ADD COLUMN "team" "Team" NOT NULL DEFAULT 'STREAMING';

ALTER TABLE "TimeEntry" ADD COLUMN "showId" TEXT;

CREATE INDEX "TimeEntry_showId_idx" ON "TimeEntry"("showId");

-- SetNull, not Cascade: removing a show must never delete the record of
-- somebody's hours. The entry survives and simply stops being clamped.
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_showId_fkey"
  FOREIGN KEY ("showId") REFERENCES "Show"("id") ON DELETE SET NULL ON UPDATE CASCADE;

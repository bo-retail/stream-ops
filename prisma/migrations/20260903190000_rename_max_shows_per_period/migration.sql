-- The cap is per scheduling period now, not per week. Renamed rather than
-- dropped and recreated, so an existing limit survives.
ALTER TABLE "Settings" RENAME COLUMN "maxShowsPerWeek" TO "maxShowsPerPeriod";

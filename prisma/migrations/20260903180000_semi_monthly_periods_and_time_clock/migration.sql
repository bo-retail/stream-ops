-- Three changes, written by hand so nothing is dropped and recreated:
--
--   1. Weeks become semi-monthly periods (1st–15th, 16th–end of month), so the
--      schedule lines up with the pay calendar.
--   2. Scheduling gains a priority per person and a requested show count per
--      period, which is what the auto-fill ranks on.
--   3. A time clock, independent of the schedule, with an append-only history.
--
-- Existing weeks are folded into the period that contains their Monday. Two
-- weeks can land in the same period, so shows are re-pointed before the
-- duplicate period rows are removed.

-- ---------------------------------------------------------------- 1. periods

ALTER TABLE "ScheduleWeek" RENAME TO "SchedulePeriod";
ALTER TABLE "SchedulePeriod" RENAME COLUMN "weekStart" TO "startDate";
ALTER TABLE "SchedulePeriod" ADD COLUMN "endDate" DATE;

-- Every unique index that the snapping updates below could transiently violate
-- has to come off first. Postgres checks uniqueness per row, not at the end of
-- the statement, so two rows collapsing onto the same value fails mid-update
-- even though the row that would have collided is about to be deleted.
ALTER TABLE "SchedulePeriod" DROP CONSTRAINT IF EXISTS "ScheduleWeek_weekStart_key";
DROP INDEX IF EXISTS "ScheduleWeek_weekStart_key";
DROP INDEX IF EXISTS "ScheduleSnapshot_weekId_version_key";
DROP INDEX IF EXISTS "AvailabilitySubmission_userId_weekStart_key";

-- Snap each existing row to the start of the period its date falls in.
UPDATE "SchedulePeriod"
SET "startDate" = CASE
  WHEN EXTRACT(DAY FROM "startDate") <= 15
    THEN date_trunc('month', "startDate")::date
  ELSE (date_trunc('month', "startDate") + INTERVAL '15 days')::date
END;

-- Two former weeks can now share a start date. Keep the earliest-created row of
-- each, move everything that pointed at the others onto it, then drop them.
CREATE TEMP TABLE "period_merge" AS
SELECT id AS duplicate_id,
       FIRST_VALUE(id) OVER (PARTITION BY "startDate" ORDER BY "createdAt", id) AS keep_id
FROM "SchedulePeriod";

UPDATE "Show" s
SET "weekId" = m.keep_id
FROM "period_merge" m
WHERE s."weekId" = m.duplicate_id AND m.duplicate_id <> m.keep_id;

UPDATE "ScheduleSnapshot" ss
SET "weekId" = m.keep_id
FROM "period_merge" m
WHERE ss."weekId" = m.duplicate_id AND m.duplicate_id <> m.keep_id;

-- A snapshot version is unique per period, so a merge can collide. Renumber.
UPDATE "ScheduleSnapshot" ss
SET version = renumbered.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "weekId" ORDER BY "createdAt", id) AS rn
  FROM "ScheduleSnapshot"
) renumbered
WHERE ss.id = renumbered.id;

DELETE FROM "SchedulePeriod"
WHERE id IN (SELECT duplicate_id FROM "period_merge" WHERE duplicate_id <> keep_id);

DROP TABLE "period_merge";

-- Now the end date can be derived, and the start made unique again.
UPDATE "SchedulePeriod"
SET "endDate" = CASE
  WHEN EXTRACT(DAY FROM "startDate") = 1
    THEN (date_trunc('month', "startDate") + INTERVAL '14 days')::date
  ELSE (date_trunc('month', "startDate") + INTERVAL '1 month' - INTERVAL '1 day')::date
END;

ALTER TABLE "SchedulePeriod" ALTER COLUMN "endDate" SET NOT NULL;

ALTER INDEX "ScheduleWeek_pkey" RENAME TO "SchedulePeriod_pkey";
CREATE UNIQUE INDEX "SchedulePeriod_startDate_key" ON "SchedulePeriod"("startDate");

-- RENAME TABLE leaves foreign key constraints under their old names, which shows
-- up forever after as phantom drift in `migrate diff`.
ALTER TABLE "SchedulePeriod"
  RENAME CONSTRAINT "ScheduleWeek_publishedById_fkey" TO "SchedulePeriod_publishedById_fkey";
ALTER TABLE "SchedulePeriod"
  RENAME CONSTRAINT "ScheduleWeek_availabilityOpenedById_fkey" TO "SchedulePeriod_availabilityOpenedById_fkey";
DROP INDEX IF EXISTS "ScheduleWeek_status_weekStart_idx";
DROP INDEX IF EXISTS "ScheduleWeek_availabilityStatus_weekStart_idx";
CREATE INDEX "SchedulePeriod_status_startDate_idx" ON "SchedulePeriod"("status", "startDate");
CREATE INDEX "SchedulePeriod_availabilityStatus_startDate_idx" ON "SchedulePeriod"("availabilityStatus", "startDate");

-- Show and snapshot now point at a period, not a week.
ALTER TABLE "Show" RENAME COLUMN "weekId" TO "periodId";
ALTER TABLE "ScheduleSnapshot" RENAME COLUMN "weekId" TO "periodId";

ALTER TABLE "Show" DROP CONSTRAINT "Show_weekId_fkey";
ALTER TABLE "Show" ADD CONSTRAINT "Show_periodId_fkey"
  FOREIGN KEY ("periodId") REFERENCES "SchedulePeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScheduleSnapshot" DROP CONSTRAINT "ScheduleSnapshot_weekId_fkey";
ALTER TABLE "ScheduleSnapshot" ADD CONSTRAINT "ScheduleSnapshot_periodId_fkey"
  FOREIGN KEY ("periodId") REFERENCES "SchedulePeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "Show_weekId_date_idx";
CREATE INDEX "Show_periodId_date_idx" ON "Show"("periodId", "date");

CREATE UNIQUE INDEX "ScheduleSnapshot_periodId_version_key" ON "ScheduleSnapshot"("periodId", "version");

-- Availability is keyed by period start too.
ALTER TABLE "Availability" RENAME COLUMN "weekStart" TO "periodStart";
UPDATE "Availability"
SET "periodStart" = CASE
  WHEN EXTRACT(DAY FROM "date") <= 15 THEN date_trunc('month', "date")::date
  ELSE (date_trunc('month', "date") + INTERVAL '15 days')::date
END;
ALTER INDEX "Availability_userId_weekStart_idx" RENAME TO "Availability_userId_periodStart_idx";
ALTER INDEX "Availability_weekStart_date_idx" RENAME TO "Availability_periodStart_date_idx";

ALTER TABLE "AvailabilitySubmission" RENAME COLUMN "weekStart" TO "periodStart";
UPDATE "AvailabilitySubmission"
SET "periodStart" = CASE
  WHEN EXTRACT(DAY FROM "periodStart") <= 15 THEN date_trunc('month', "periodStart")::date
  ELSE (date_trunc('month', "periodStart") + INTERVAL '15 days')::date
END;

-- Snapping collides here too: one person, two weeks, now the same period. Keep
-- the earliest submission of each pair.
DELETE FROM "AvailabilitySubmission" a
USING "AvailabilitySubmission" b
WHERE a."userId" = b."userId"
  AND a."periodStart" = b."periodStart"
  AND a.id > b.id;

CREATE UNIQUE INDEX "AvailabilitySubmission_userId_periodStart_key"
  ON "AvailabilitySubmission"("userId", "periodStart");
ALTER INDEX "AvailabilitySubmission_weekStart_idx" RENAME TO "AvailabilitySubmission_periodStart_idx";

-- ------------------------------------------------------------- 2. priorities

ALTER TABLE "User" ADD COLUMN "schedulingPriority" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "User_schedulingPriority_idx" ON "User"("schedulingPriority");

ALTER TABLE "AvailabilitySubmission" ADD COLUMN "requestedShows" INTEGER;

-- ------------------------------------------------------------- 3. time clock

CREATE TYPE "TimeEntrySource" AS ENUM ('SELF', 'ADMIN');

CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clockInAt" TIMESTAMP(3) NOT NULL,
    "clockOutAt" TIMESTAMP(3),
    "note" TEXT,
    "source" "TimeEntrySource" NOT NULL DEFAULT 'SELF',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TimeEntryRevision" (
    "id" TEXT NOT NULL,
    "timeEntryId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "clockInAt" TIMESTAMP(3) NOT NULL,
    "clockOutAt" TIMESTAMP(3),
    "note" TEXT,
    "reason" TEXT,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntryRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TimeEntry_userId_clockInAt_idx" ON "TimeEntry"("userId", "clockInAt");
CREATE INDEX "TimeEntry_clockInAt_idx" ON "TimeEntry"("clockInAt");
CREATE INDEX "TimeEntry_userId_clockOutAt_idx" ON "TimeEntry"("userId", "clockOutAt");

CREATE UNIQUE INDEX "TimeEntryRevision_timeEntryId_version_key" ON "TimeEntryRevision"("timeEntryId", "version");
CREATE INDEX "TimeEntryRevision_changedAt_idx" ON "TimeEntryRevision"("changedAt");

ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TimeEntryRevision" ADD CONSTRAINT "TimeEntryRevision_timeEntryId_fkey"
  FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TimeEntryRevision" ADD CONSTRAINT "TimeEntryRevision_changedById_fkey"
  FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A shift cannot end before it started, and nobody can be clocked in twice at
-- once. The first is a check; the second is a partial unique index, which is the
-- only way to say "at most one open entry per person" in Postgres.
ALTER TABLE "TimeEntry"
  ADD CONSTRAINT "TimeEntry_ends_after_it_starts"
  CHECK ("clockOutAt" IS NULL OR "clockOutAt" > "clockInAt");

CREATE UNIQUE INDEX "TimeEntry_one_open_per_user"
  ON "TimeEntry"("userId") WHERE "clockOutAt" IS NULL;

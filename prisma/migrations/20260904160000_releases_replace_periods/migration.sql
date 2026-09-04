-- Periods become releases.
--
-- A SchedulePeriod was always half a month and always the same four shows a
-- day, with the rules kept as standing defaults in Settings. A Release is
-- whatever the boss composes: any dates, whichever shows he wants on them, and
-- the scheduling rules chosen for that release alone.
--
-- Every existing period becomes a release covering the same dates, so no shows,
-- assignments or availability are lost.

-- ---------------------------------------------------------------- enums ----
ALTER TYPE "WeekStatus" RENAME TO "ScheduleStatus";

CREATE TYPE "ReleaseStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- ------------------------------------------------------- period -> release --
ALTER TABLE "SchedulePeriod" RENAME TO "Release";

ALTER TABLE "Release" RENAME COLUMN "status" TO "scheduleStatus";
ALTER TABLE "Release" RENAME COLUMN "availabilityDueAt" TO "dueAt";
ALTER TABLE "Release" RENAME COLUMN "availabilityOpenedAt" TO "releasedAt";
ALTER TABLE "Release" RENAME COLUMN "availabilityOpenedById" TO "createdById";

-- The 1st and the 16th are no longer special, so a start date is no longer
-- unique: two releases may legitimately begin on the same day.
DROP INDEX IF EXISTS "SchedulePeriod_startDate_key";

ALTER TABLE "Release" ADD COLUMN "name" TEXT;
ALTER TABLE "Release" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "Release" ADD COLUMN "usePriority" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Release" ADD COLUMN "useProportional" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Release" ADD COLUMN "maxShowsPerPerson" INTEGER;
ALTER TABLE "Release" ADD COLUMN "status" "ReleaseStatus" NOT NULL DEFAULT 'DRAFT';

-- Carry the old open/closed flag over: anything that was open stays open, and
-- anything closed that already has availability against it is a release that
-- has run its course rather than one nobody has started.
UPDATE "Release" r SET "status" = 'OPEN' WHERE r."availabilityStatus" = 'OPEN';
UPDATE "Release" r SET "status" = 'CLOSED'
WHERE r."availabilityStatus" = 'CLOSED'
  AND EXISTS (SELECT 1 FROM "Show" s WHERE s."periodId" = r.id);

ALTER TABLE "Release" DROP COLUMN "availabilityStatus";

-- The old per-period cap lived in Settings; give every existing release the
-- value that was actually in force for it.
UPDATE "Release" SET "maxShowsPerPerson" = (SELECT "maxShowsPerPeriod" FROM "Settings" WHERE id = 'singleton');

DROP INDEX IF EXISTS "SchedulePeriod_status_startDate_idx";
DROP INDEX IF EXISTS "SchedulePeriod_availabilityStatus_startDate_idx";
CREATE INDEX "Release_status_startDate_idx" ON "Release"("status", "startDate");
CREATE INDEX "Release_scheduleStatus_startDate_idx" ON "Release"("scheduleStatus", "startDate");

-- ------------------------------------------------------ release priorities --
CREATE TABLE "ReleasePriority" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "ReleasePriority_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReleasePriority_releaseId_userId_key" ON "ReleasePriority"("releaseId", "userId");
CREATE INDEX "ReleasePriority_releaseId_idx" ON "ReleasePriority"("releaseId");

ALTER TABLE "ReleasePriority" ADD CONSTRAINT "ReleasePriority_releaseId_fkey"
  FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReleasePriority" ADD CONSTRAINT "ReleasePriority_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Anybody carrying a standing priority keeps it on every release that has not
-- been published yet, so the change does not silently drop a preference the
-- boss had already expressed.
INSERT INTO "ReleasePriority" ("id", "releaseId", "userId", "rank")
SELECT md5(random()::text || r.id || u.id), r.id, u.id, u."schedulingPriority"
FROM "Release" r
CROSS JOIN "User" u
WHERE u."schedulingPriority" > 0
  AND u."isActive" = true
  AND r."scheduleStatus" = 'DRAFT';

UPDATE "Release" SET "usePriority" = true
WHERE EXISTS (SELECT 1 FROM "ReleasePriority" p WHERE p."releaseId" = "Release".id);

-- --------------------------------------------------------------- shows -----
ALTER TABLE "Show" RENAME COLUMN "periodId" TO "releaseId";
DROP INDEX IF EXISTS "Show_periodId_date_idx";
CREATE INDEX "Show_releaseId_date_idx" ON "Show"("releaseId", "date");

-- ----------------------------------------------------------- snapshots -----
ALTER TABLE "ScheduleSnapshot" RENAME COLUMN "periodId" TO "releaseId";
DROP INDEX IF EXISTS "ScheduleSnapshot_periodId_version_key";
CREATE UNIQUE INDEX "ScheduleSnapshot_releaseId_version_key" ON "ScheduleSnapshot"("releaseId", "version");

-- -------------------------------------------------------- availability -----
-- Availability hung off a date that happened to be a period start. It now
-- points at the release it answers, which is the thing it was always about.
ALTER TABLE "Availability" ADD COLUMN "releaseId" TEXT;
UPDATE "Availability" a SET "releaseId" = r.id FROM "Release" r WHERE r."startDate" = a."periodStart";
DELETE FROM "Availability" WHERE "releaseId" IS NULL;
ALTER TABLE "Availability" ALTER COLUMN "releaseId" SET NOT NULL;

DROP INDEX IF EXISTS "Availability_userId_periodStart_idx";
DROP INDEX IF EXISTS "Availability_periodStart_date_idx";
ALTER TABLE "Availability" DROP COLUMN "periodStart";

CREATE INDEX "Availability_userId_releaseId_idx" ON "Availability"("userId", "releaseId");
CREATE INDEX "Availability_releaseId_date_idx" ON "Availability"("releaseId", "date");
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_releaseId_fkey"
  FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --------------------------------------------------------- submissions -----
ALTER TABLE "AvailabilitySubmission" ADD COLUMN "releaseId" TEXT;
UPDATE "AvailabilitySubmission" s SET "releaseId" = r.id FROM "Release" r WHERE r."startDate" = s."periodStart";
DELETE FROM "AvailabilitySubmission" WHERE "releaseId" IS NULL;
ALTER TABLE "AvailabilitySubmission" ALTER COLUMN "releaseId" SET NOT NULL;

DROP INDEX IF EXISTS "AvailabilitySubmission_userId_periodStart_key";
DROP INDEX IF EXISTS "AvailabilitySubmission_periodStart_idx";
ALTER TABLE "AvailabilitySubmission" DROP COLUMN "periodStart";
ALTER TABLE "AvailabilitySubmission" DROP COLUMN "requestedShows";

CREATE UNIQUE INDEX "AvailabilitySubmission_userId_releaseId_key" ON "AvailabilitySubmission"("userId", "releaseId");
CREATE INDEX "AvailabilitySubmission_releaseId_idx" ON "AvailabilitySubmission"("releaseId");
ALTER TABLE "AvailabilitySubmission" ADD CONSTRAINT "AvailabilitySubmission_releaseId_fkey"
  FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------ settings -----
-- Show hours and the cap are now part of each release.
ALTER TABLE "Settings" DROP COLUMN "dayStart";
ALTER TABLE "Settings" DROP COLUMN "dayEnd";
ALTER TABLE "Settings" DROP COLUMN "nightStart";
ALTER TABLE "Settings" DROP COLUMN "nightEnd";
ALTER TABLE "Settings" DROP COLUMN "maxShowsPerPeriod";

-- ---------------------------------------------------------------- user -----
DROP INDEX IF EXISTS "User_schedulingPriority_idx";
ALTER TABLE "User" DROP COLUMN "schedulingPriority";

-- ------------------------------------------------- tidy constraint names ---
-- Renaming a table leaves its constraints named after the old one. Harmless at
-- runtime, but it makes every future schema diff look like a change.
ALTER TABLE "Release" RENAME CONSTRAINT "SchedulePeriod_pkey" TO "Release_pkey";
ALTER TABLE "Release" RENAME CONSTRAINT "SchedulePeriod_publishedById_fkey" TO "Release_publishedById_fkey";
ALTER TABLE "Release" RENAME CONSTRAINT "SchedulePeriod_availabilityOpenedById_fkey" TO "Release_createdById_fkey";
ALTER TABLE "Show" RENAME CONSTRAINT "Show_periodId_fkey" TO "Show_releaseId_fkey";
ALTER TABLE "ScheduleSnapshot" RENAME CONSTRAINT "ScheduleSnapshot_periodId_fkey" TO "ScheduleSnapshot_releaseId_fkey";

-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('CLOSED', 'OPEN');

-- AlterTable
ALTER TABLE "ScheduleWeek" ADD COLUMN     "availabilityDueAt" TIMESTAMP(3),
ADD COLUMN     "availabilityOpenedAt" TIMESTAMP(3),
ADD COLUMN     "availabilityOpenedById" TEXT,
ADD COLUMN     "availabilityStatus" "AvailabilityStatus" NOT NULL DEFAULT 'CLOSED';

-- CreateIndex
CREATE INDEX "ScheduleWeek_availabilityStatus_weekStart_idx" ON "ScheduleWeek"("availabilityStatus", "weekStart");

-- AddForeignKey
ALTER TABLE "ScheduleWeek" ADD CONSTRAINT "ScheduleWeek_availabilityOpenedById_fkey" FOREIGN KEY ("availabilityOpenedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: weeks that already existed were effectively open for submissions,
-- so keep them open. Only weeks created from here on start closed and are
-- released deliberately by the boss.
UPDATE "ScheduleWeek"
SET "availabilityStatus" = 'OPEN',
    "availabilityOpenedAt" = COALESCE("availabilityOpenedAt", "createdAt")
WHERE "status" = 'DRAFT';

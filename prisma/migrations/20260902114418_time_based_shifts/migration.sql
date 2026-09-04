-- CreateEnum
CREATE TYPE "Position" AS ENUM ('STREAMER', 'COMPUTER');

-- DropForeignKey
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_showSlotId_fkey";

-- DropForeignKey
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_userId_fkey";

-- DropForeignKey
ALTER TABLE "Availability" DROP CONSTRAINT "Availability_userId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollAdjustment" DROP CONSTRAINT "PayrollAdjustment_createdById_fkey";

-- DropForeignKey
ALTER TABLE "PayrollAdjustment" DROP CONSTRAINT "PayrollAdjustment_userId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRun" DROP CONSTRAINT "PayrollRun_lockedById_fkey";

-- DropForeignKey
ALTER TABLE "SalesEntry" DROP CONSTRAINT "SalesEntry_enteredById_fkey";

-- DropForeignKey
ALTER TABLE "SalesEntry" DROP CONSTRAINT "SalesEntry_showSlotId_fkey";

-- DropForeignKey
ALTER TABLE "SalesEntryRevision" DROP CONSTRAINT "SalesEntryRevision_changedById_fkey";

-- DropForeignKey
ALTER TABLE "SalesEntryRevision" DROP CONSTRAINT "SalesEntryRevision_salesEntryId_fkey";

-- DropForeignKey
ALTER TABLE "ShowSlot" DROP CONSTRAINT "ShowSlot_cancelledById_fkey";

-- DropForeignKey
ALTER TABLE "ShowSlot" DROP CONSTRAINT "ShowSlot_weekId_fkey";

-- AlterTable
ALTER TABLE "Settings" DROP COLUMN "baseHourlyRateCents",
DROP COLUMN "commissionModel",
DROP COLUMN "commissionRateBps",
DROP COLUMN "maxShowsPerWeek",
DROP COLUMN "payPeriodAnchor",
DROP COLUMN "payPeriodType",
DROP COLUMN "targetSellersPerShow",
ADD COLUMN     "maxHoursPerWeek" INTEGER;

-- DropTable
DROP TABLE "Assignment";

-- DropTable
DROP TABLE "Availability";

-- DropTable
DROP TABLE "PayrollAdjustment";

-- DropTable
DROP TABLE "PayrollRun";

-- DropTable
DROP TABLE "SalesEntry";

-- DropTable
DROP TABLE "SalesEntryRevision";

-- DropTable
DROP TABLE "ShowSlot";

-- DropEnum
DROP TYPE "CommissionModel";

-- DropEnum
DROP TYPE "PayPeriodType";

-- DropEnum
DROP TYPE "SlotType";

-- CreateTable
CREATE TABLE "CoverageWindow" (
    "id" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "platform" "Platform" NOT NULL,
    "position" "Position" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoverageWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "platform" "Platform" NOT NULL,
    "position" "Position" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityWindow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "date" DATE NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "position" "Position",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilityWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoverageWindow_weekId_date_idx" ON "CoverageWindow"("weekId", "date");

-- CreateIndex
CREATE INDEX "CoverageWindow_date_platform_position_idx" ON "CoverageWindow"("date", "platform", "position");

-- CreateIndex
CREATE INDEX "Shift_weekId_date_idx" ON "Shift"("weekId", "date");

-- CreateIndex
CREATE INDEX "Shift_userId_startsAt_idx" ON "Shift"("userId", "startsAt");

-- CreateIndex
CREATE INDEX "Shift_date_platform_position_idx" ON "Shift"("date", "platform", "position");

-- CreateIndex
CREATE INDEX "AvailabilityWindow_userId_weekStart_idx" ON "AvailabilityWindow"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "AvailabilityWindow_weekStart_date_idx" ON "AvailabilityWindow"("weekStart", "date");

-- AddForeignKey
ALTER TABLE "CoverageWindow" ADD CONSTRAINT "CoverageWindow_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "ScheduleWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "ScheduleWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityWindow" ADD CONSTRAINT "AvailabilityWindow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

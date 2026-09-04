-- CreateEnum
CREATE TYPE "Slot" AS ENUM ('DAY', 'NIGHT');

-- CreateEnum
CREATE TYPE "ShowStatus" AS ENUM ('SCHEDULED', 'CANCELLED');

-- DropForeignKey
ALTER TABLE "AvailabilityWindow" DROP CONSTRAINT "AvailabilityWindow_userId_fkey";

-- DropForeignKey
ALTER TABLE "CoverageWindow" DROP CONSTRAINT "CoverageWindow_weekId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRun" DROP CONSTRAINT "PayrollRun_lockedById_fkey";

-- DropForeignKey
ALTER TABLE "Shift" DROP CONSTRAINT "Shift_userId_fkey";

-- DropForeignKey
ALTER TABLE "Shift" DROP CONSTRAINT "Shift_weekId_fkey";

-- DropForeignKey
ALTER TABLE "ShiftSale" DROP CONSTRAINT "ShiftSale_enteredById_fkey";

-- DropForeignKey
ALTER TABLE "ShiftSale" DROP CONSTRAINT "ShiftSale_shiftId_fkey";

-- DropForeignKey
ALTER TABLE "ShiftSaleRevision" DROP CONSTRAINT "ShiftSaleRevision_changedById_fkey";

-- DropForeignKey
ALTER TABLE "ShiftSaleRevision" DROP CONSTRAINT "ShiftSaleRevision_shiftSaleId_fkey";

-- AlterTable
ALTER TABLE "Settings" DROP COLUMN "baseHourlyRateCents",
DROP COLUMN "commissionRateBps",
DROP COLUMN "dayStreamEnd",
DROP COLUMN "dayStreamStart",
DROP COLUMN "maxHoursPerWeek",
DROP COLUMN "nightStreamEnd",
DROP COLUMN "nightStreamStart",
DROP COLUMN "payPeriodAnchor",
DROP COLUMN "payPeriodType",
ADD COLUMN     "dayEnd" TEXT NOT NULL DEFAULT '19:00',
ADD COLUMN     "dayStart" TEXT NOT NULL DEFAULT '13:00',
ADD COLUMN     "maxShowsPerWeek" INTEGER,
ADD COLUMN     "nightEnd" TEXT NOT NULL DEFAULT '01:00',
ADD COLUMN     "nightStart" TEXT NOT NULL DEFAULT '19:00';

-- DropTable
DROP TABLE "AvailabilityWindow";

-- DropTable
DROP TABLE "CoverageWindow";

-- DropTable
DROP TABLE "PayrollRun";

-- DropTable
DROP TABLE "Shift";

-- DropTable
DROP TABLE "ShiftSale";

-- DropTable
DROP TABLE "ShiftSaleRevision";

-- DropEnum
DROP TYPE "PayPeriodType";

-- CreateTable
CREATE TABLE "Show" (
    "id" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "platform" "Platform" NOT NULL,
    "slot" "Slot" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "ShowStatus" NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Show_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "showId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "position" "Position" NOT NULL,
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Availability" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "date" DATE NOT NULL,
    "slot" "Slot" NOT NULL,
    "position" "Position",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Show_weekId_date_idx" ON "Show"("weekId", "date");

-- CreateIndex
CREATE INDEX "Show_status_date_idx" ON "Show"("status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Show_date_platform_slot_key" ON "Show"("date", "platform", "slot");

-- CreateIndex
CREATE INDEX "Assignment_userId_idx" ON "Assignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_showId_position_key" ON "Assignment"("showId", "position");

-- CreateIndex
CREATE INDEX "Availability_userId_weekStart_idx" ON "Availability"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "Availability_weekStart_date_idx" ON "Availability"("weekStart", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Availability_userId_date_slot_key" ON "Availability"("userId", "date", "slot");

-- AddForeignKey
ALTER TABLE "Show" ADD CONSTRAINT "Show_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "ScheduleWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_showId_fkey" FOREIGN KEY ("showId") REFERENCES "Show"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

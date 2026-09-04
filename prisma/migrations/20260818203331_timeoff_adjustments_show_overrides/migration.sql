-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "maxShowsPerWeek" INTEGER,
ADD COLUMN     "targetSellersPerShow" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "ShowSlot" ADD COLUMN     "commissionRateBps" INTEGER,
ADD COLUMN     "notes" TEXT;

-- CreateTable
CREATE TABLE "TimeOff" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "note" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAdjustment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimeOff_userId_startDate_endDate_idx" ON "TimeOff"("userId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "TimeOff_startDate_endDate_idx" ON "TimeOff"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_date_idx" ON "PayrollAdjustment"("date");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_userId_date_idx" ON "PayrollAdjustment"("userId", "date");

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

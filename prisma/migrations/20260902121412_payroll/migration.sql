-- CreateEnum
CREATE TYPE "PayPeriodType" AS ENUM ('WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "baseHourlyRateCents" INTEGER NOT NULL DEFAULT 3000,
ADD COLUMN     "commissionRateBps" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "payPeriodAnchor" DATE NOT NULL DEFAULT CURRENT_DATE,
ADD COLUMN     "payPeriodType" "PayPeriodType" NOT NULL DEFAULT 'BIWEEKLY';

-- CreateTable
CREATE TABLE "ShiftSale" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "revenueCents" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "enteredById" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftSaleRevision" (
    "id" TEXT NOT NULL,
    "shiftSaleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "revenueCents" INTEGER NOT NULL,
    "reason" TEXT,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftSaleRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "lockedById" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShiftSale_shiftId_key" ON "ShiftSale"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftSaleRevision_shiftSaleId_version_key" ON "ShiftSaleRevision"("shiftSaleId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_periodStart_periodEnd_key" ON "PayrollRun"("periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "ShiftSale" ADD CONSTRAINT "ShiftSale_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSale" ADD CONSTRAINT "ShiftSale_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSaleRevision" ADD CONSTRAINT "ShiftSaleRevision_shiftSaleId_fkey" FOREIGN KEY ("shiftSaleId") REFERENCES "ShiftSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSaleRevision" ADD CONSTRAINT "ShiftSaleRevision_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

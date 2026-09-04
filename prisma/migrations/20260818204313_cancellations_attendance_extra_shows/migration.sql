-- DropIndex
DROP INDEX "ShowSlot_weekId_date_platform_slotType_key";

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "absenceReason" TEXT,
ADD COLUMN     "attended" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "hoursHundredths" INTEGER;

-- AlterTable
ALTER TABLE "ShowSlot" ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "payDespiteCancellation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sequence" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "ShowSlot_weekId_date_platform_slotType_sequence_key" ON "ShowSlot"("weekId", "date", "platform", "slotType", "sequence");

-- AddForeignKey
ALTER TABLE "ShowSlot" ADD CONSTRAINT "ShowSlot_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

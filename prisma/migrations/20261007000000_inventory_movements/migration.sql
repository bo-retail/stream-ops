-- Inventory, step 4: moving stock by hand.
--
-- Purely additive: new kinds of stock line (move, adjustment, return), two
-- states of a sold watch (cancelled, returned), a reason on each stock line,
-- and one row per save so it can be undone by reversing lines.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMoveKind" ADD VALUE 'MOVE';
ALTER TYPE "StockMoveKind" ADD VALUE 'ADJUST';
ALTER TYPE "StockMoveKind" ADD VALUE 'RETURN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockSaleStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "StockSaleStatus" ADD VALUE 'RETURNED';

-- AlterTable
ALTER TABLE "StockMove" ADD COLUMN     "reason" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "StockEntry" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "byId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,

    CONSTRAINT "StockEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockEntry_at_idx" ON "StockEntry"("at");

-- AddForeignKey
ALTER TABLE "StockEntry" ADD CONSTRAINT "StockEntry_byId_fkey" FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockEntry" ADD CONSTRAINT "StockEntry_undoneById_fkey" FOREIGN KEY ("undoneById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

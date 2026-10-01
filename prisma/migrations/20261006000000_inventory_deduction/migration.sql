-- Inventory, step 3: paid orders come off stock.
--
-- Purely additive. Nothing moves until a director sets
-- Settings.inventoryStartDate (null for everyone after this migration), so
-- deploying it changes no stock. SalesRecord gains the reports' "Model #"
-- column (blank on every existing row). A sold watch (StockSale) and its stock
-- lines are RESTRICT: never removed by deleting anything else.

-- CreateEnum
CREATE TYPE "StockSaleStatus" AS ENUM ('SOLD', 'SENT', 'UNDONE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMoveKind" ADD VALUE 'SOLD';
ALTER TYPE "StockMoveKind" ADD VALUE 'SENT';

-- AlterEnum
ALTER TYPE "StockPlace" ADD VALUE 'WAITING';

-- AlterTable
ALTER TABLE "SalesRecord" ADD COLUMN     "modelNumber" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "inventoryStartDate" DATE;

-- AlterTable
ALTER TABLE "StockMove" ADD COLUMN     "saleId" TEXT;

-- CreateTable
CREATE TABLE "StockSale" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "orderRef" TEXT NOT NULL,
    "showDate" DATE NOT NULL,
    "show" TEXT NOT NULL,
    "tracking" TEXT NOT NULL DEFAULT '',
    "listing" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "place" "StockPlace" NOT NULL,
    "costCents" INTEGER,
    "status" "StockSaleStatus" NOT NULL DEFAULT 'SOLD',
    "sentAt" TIMESTAMP(3),
    "flag" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockSale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockSale_key_key" ON "StockSale"("key");

-- CreateIndex
CREATE INDEX "StockSale_status_showDate_idx" ON "StockSale"("status", "showDate");

-- CreateIndex
CREATE INDEX "StockSale_productId_idx" ON "StockSale"("productId");

-- CreateIndex
CREATE INDEX "StockSale_showDate_idx" ON "StockSale"("showDate");

-- CreateIndex
CREATE INDEX "StockMove_saleId_idx" ON "StockMove"("saleId");

-- AddForeignKey
ALTER TABLE "StockSale" ADD CONSTRAINT "StockSale_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "StockSale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

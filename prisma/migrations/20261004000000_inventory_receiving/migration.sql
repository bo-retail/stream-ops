-- Inventory, step 2: receiving.
--
-- Purely additive. Offers and shipments are new tables; Product gains
-- "active" (every existing model stays active); StockMove gains the cost and
-- the shipment of a receipt. A counted shipment can never be deleted: its
-- lines and its stock lines are RESTRICT, never cascade (the 09/22 lesson).

-- AlterEnum
ALTER TYPE "StockMoveKind" ADD VALUE 'RECEIVED';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "StockMove" ADD COLUMN     "shipmentId" TEXT,
ADD COLUMN     "unitCostCents" INTEGER;

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "fileName" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byId" TEXT,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferLine" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL,

    CONSTRAINT "OfferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "sop" TEXT NOT NULL,
    "po" TEXT NOT NULL DEFAULT '',
    "fileName" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byId" TEXT,
    "countedAt" TIMESTAMP(3),

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentLine" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "listedQty" INTEGER NOT NULL,
    "unitCostCents" INTEGER,
    "countedQty" INTEGER,
    "damagedQty" INTEGER,
    "settledAt" TIMESTAMP(3),
    "settledNote" TEXT NOT NULL DEFAULT '',
    "settledById" TEXT,

    CONSTRAINT "ShipmentLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Offer_date_key" ON "Offer"("date");

-- CreateIndex
CREATE INDEX "OfferLine_productId_idx" ON "OfferLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferLine_offerId_productId_key" ON "OfferLine"("offerId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_sop_key" ON "Shipment"("sop");

-- CreateIndex
CREATE INDEX "ShipmentLine_productId_idx" ON "ShipmentLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentLine_shipmentId_productId_key" ON "ShipmentLine"("shipmentId", "productId");

-- CreateIndex
CREATE INDEX "StockMove_shipmentId_idx" ON "StockMove"("shipmentId");

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_byId_fkey" FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferLine" ADD CONSTRAINT "OfferLine_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferLine" ADD CONSTRAINT "OfferLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_byId_fkey" FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_settledById_fkey" FOREIGN KEY ("settledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Quantities are never negative, damaged is part of what was counted, and an
-- offer line orders at least one.
ALTER TABLE "OfferLine" ADD CONSTRAINT "OfferLine_sane" CHECK ("qty" > 0 AND "costCents" >= 0);
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_sane" CHECK (
  "listedQty" >= 0
  AND ("unitCostCents" IS NULL OR "unitCostCents" >= 0)
  AND ("countedQty" IS NULL OR "countedQty" >= 0)
  AND ("damagedQty" IS NULL OR ("damagedQty" >= 0 AND "countedQty" IS NOT NULL AND "damagedQty" <= "countedQty"))
);
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_unitCost_not_negative" CHECK ("unitCostCents" IS NULL OR "unitCostCents" >= 0);

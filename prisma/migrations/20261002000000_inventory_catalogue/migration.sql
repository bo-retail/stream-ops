-- Inventory, step 1: the catalogue and the stock history.
--
-- Purely additive: two new tables and two enums. Nothing existing is changed,
-- and nothing reads these tables until the inventory pages do.
--
-- StockMove is append-only. Its foreign key to Product is RESTRICT, so stock
-- history can never disappear because something else was deleted.

CREATE TYPE "StockPlace" AS ENUM ('SELLABLE', 'SAMPLE_EBAY', 'SAMPLE_TIKTOK', 'RANDOM_PULLS', 'DAMAGED');
CREATE TYPE "StockMoveKind" AS ENUM ('COUNT');

CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "collection" TEXT NOT NULL DEFAULT '',
    "series" TEXT NOT NULL DEFAULT '',
    "gender" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "costCents" INTEGER,
    "tpCents" INTEGER,
    "msrpCents" INTEGER,
    "weightLb" DOUBLE PRECISION,
    "lengthIn" DOUBLE PRECISION,
    "widthIn" DOUBLE PRECISION,
    "heightIn" DOUBLE PRECISION,
    "ebayShippingProfile" TEXT NOT NULL DEFAULT '',
    "upc" TEXT NOT NULL DEFAULT '',
    "needsDetails" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Product_model_key" ON "Product"("model");

CREATE TABLE "StockMove" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "place" "StockPlace" NOT NULL,
    "qty" INTEGER NOT NULL,
    "kind" "StockMoveKind" NOT NULL,
    "countedQty" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "entryId" TEXT NOT NULL,
    "byId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMove_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StockMove_productId_place_idx" ON "StockMove"("productId", "place");
CREATE INDEX "StockMove_entryId_idx" ON "StockMove"("entryId");
CREATE INDEX "StockMove_at_idx" ON "StockMove"("at");

ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_byId_fkey" FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A count can never be negative, and money is never negative.
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_countedQty_not_negative" CHECK ("countedQty" IS NULL OR "countedQty" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_money_not_negative"
  CHECK (("costCents" IS NULL OR "costCents" >= 0) AND ("tpCents" IS NULL OR "tpCents" >= 0) AND ("msrpCents" IS NULL OR "msrpCents" >= 0));

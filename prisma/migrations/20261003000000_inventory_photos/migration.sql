-- Inventory: photos of a model taken or chosen in the app.
--
-- Purely additive: one new table. Its key is the product, so a model has at
-- most one photo, and replacing it overwrites the row. It cascades from
-- Product only; Product itself cannot be deleted once it has stock history.

-- CreateTable
CREATE TABLE "ProductPhoto" (
    "productId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPhoto_pkey" PRIMARY KEY ("productId")
);

-- AddForeignKey
ALTER TABLE "ProductPhoto" ADD CONSTRAINT "ProductPhoto_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

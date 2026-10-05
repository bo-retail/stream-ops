-- Inventory, step 5: the day's plan (AM eBay, PM eBay, the rest on TikTok).
-- Two new tables, nothing else touched. Named to sort after 20261009.

-- CreateTable
CREATE TABLE "ShowPlan" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "savedById" TEXT,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowPlanLine" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ebayAm" INTEGER NOT NULL DEFAULT 0,
    "ebayPm" INTEGER NOT NULL DEFAULT 0,
    "tiktok" INTEGER NOT NULL DEFAULT 0,
    "setPrice" BOOLEAN NOT NULL DEFAULT false,
    "available" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ShowPlanLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShowPlan_date_key" ON "ShowPlan"("date");

-- CreateIndex
CREATE INDEX "ShowPlanLine_productId_idx" ON "ShowPlanLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ShowPlanLine_planId_productId_key" ON "ShowPlanLine"("planId", "productId");

-- AddForeignKey
ALTER TABLE "ShowPlan" ADD CONSTRAINT "ShowPlan_savedById_fkey" FOREIGN KEY ("savedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowPlanLine" ADD CONSTRAINT "ShowPlanLine_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ShowPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowPlanLine" ADD CONSTRAINT "ShowPlanLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

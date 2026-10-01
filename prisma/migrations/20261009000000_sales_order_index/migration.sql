-- Inventory: a return or cancellation looks its order up in the reports.
-- A plain index on an existing column; quick on the current table size.

-- CreateIndex
CREATE INDEX "SalesRecord_orderRef_idx" ON "SalesRecord"("orderRef");

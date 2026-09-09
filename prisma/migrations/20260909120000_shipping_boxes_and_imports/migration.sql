-- Shipping: the morning's order files, the boxes they become, and the
-- permanent record of what a packer put in each one.
--
-- Six new tables and one new role. Nothing existing is altered except the Role
-- enum, which gains a value; no column is dropped, renamed or re-typed, and no
-- existing row is touched. Running this on a live database changes nothing
-- about how the app behaves today.
--
--   Role.MANAGER          with team SHIPPING, this is the Shipping Director.
--                         requireBoss tests for BOSS exactly, so the new role
--                         is kept out of every admin page without a code change.
--   ImportBatch           one upload of a show day's exports, kept as history.
--   SalesRecord           one paid watch. Money in whole cents.
--   ImportDrop            a raw row that was not counted, and why.
--   Package               a box: one tracking number, one parcel, one buyer.
--   PackageItem           what belongs in it, as a count per stock number.
--   ScanEvent             append-only. Every scan, including the refusals.
--
-- Note on the enum: ALTER TYPE ... ADD VALUE may run inside a transaction on
-- PostgreSQL 12+, but the new value cannot be *used* until that transaction
-- commits. Nothing below uses it, so this is safe either way. If your client
-- objects, run this one statement on its own first.

-- ------------------------------------------------------------- 1. the role

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MANAGER' BEFORE 'BOSS';

-- ------------------------------------------------------------ 2. new enums

CREATE TYPE "ImportStatus" AS ENUM ('OK', 'BLOCKED');

CREATE TYPE "PackageStatus" AS ENUM ('OPEN', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE');

CREATE TYPE "ScanKind" AS ENUM (
  'LABEL',
  'ITEM_ACCEPTED',
  'ITEM_REFUSED',
  'ITEM_OVERRIDE',
  'CLOSE_COMPLETE',
  'CLOSE_INCOMPLETE',
  'REOPEN'
);

-- ---------------------------------------------------------- 3. the upload

-- Kept as history rather than one row per day: a day can legitimately be
-- uploaded again, and "who loaded what, when, and what it produced" has to stay
-- answerable. The most recent OK batch is the day's data.
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "showDate" DATE NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'OK',
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "files" JSONB NOT NULL,
    "flags" JSONB NOT NULL,
    "watchCount" INTEGER NOT NULL DEFAULT 0,
    "boxCount" INTEGER NOT NULL DEFAULT 0,
    "droppedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImportBatch_showDate_uploadedAt_idx" ON "ImportBatch"("showDate", "uploadedAt");
CREATE INDEX "ImportBatch_status_showDate_idx" ON "ImportBatch"("status", "showDate");

-- --------------------------------------------------------- 4. what was sold

-- Money is whole cents. The schedule already keeps elapsed time as integer
-- hundredths for the same reason: a float is the wrong shape for something that
-- gets totalled and paid.
CREATE TABLE "SalesRecord" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "show" TEXT NOT NULL,
    "showDate" DATE NOT NULL,
    "shiftTag" TEXT NOT NULL,
    "rawShiftTag" TEXT NOT NULL,
    "shiftTagValid" BOOLEAN NOT NULL DEFAULT true,
    "orderRef" TEXT NOT NULL,
    "lineRef" TEXT NOT NULL,
    "buyer" TEXT NOT NULL,
    "stockNumber" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER NOT NULL DEFAULT 0,
    "platformDiscountCents" INTEGER NOT NULL DEFAULT 0,
    "sellerDiscountCents" INTEGER NOT NULL DEFAULT 0,
    "netItemPriceCents" INTEGER NOT NULL DEFAULT 0,
    "shippingCents" INTEGER NOT NULL DEFAULT 0,
    "taxAndFeesCents" INTEGER NOT NULL DEFAULT 0,
    "orderTotalCents" INTEGER NOT NULL DEFAULT 0,
    "soldAt" TIMESTAMP(3),
    "paidOn" DATE,
    "shipToName" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "paymentMethod" TEXT NOT NULL DEFAULT '',
    "sourcePackageId" TEXT NOT NULL DEFAULT '',
    "tracking" TEXT NOT NULL DEFAULT '',
    "sourceFile" TEXT NOT NULL,

    CONSTRAINT "SalesRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SalesRecord_showDate_show_idx" ON "SalesRecord"("showDate", "show");
CREATE INDEX "SalesRecord_batchId_idx" ON "SalesRecord"("batchId");
CREATE INDEX "SalesRecord_tracking_idx" ON "SalesRecord"("tracking");
CREATE INDEX "SalesRecord_shiftTag_idx" ON "SalesRecord"("shiftTag");

-- A row that was not counted, and why. This is the Exceptions sheet.
CREATE TABLE "ImportDrop" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "orderRef" TEXT NOT NULL,
    "buyer" TEXT NOT NULL DEFAULT '',
    "stockNumber" TEXT NOT NULL DEFAULT '',
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,

    CONSTRAINT "ImportDrop_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImportDrop_batchId_idx" ON "ImportDrop"("batchId");

-- ------------------------------------------------------------- 5. the boxes

-- One tracking number, one parcel, one buyer. Tracking is the key rather than
-- TikTok's Package ID because eBay has no package column at all, and because
-- the tracking number is the only thing a packer can physically scan.
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "showDate" DATE NOT NULL,
    "buyer" TEXT NOT NULL DEFAULT '',
    "shipToName" TEXT NOT NULL DEFAULT '',
    "shipToState" TEXT NOT NULL DEFAULT '',
    "status" "PackageStatus" NOT NULL DEFAULT 'OPEN',
    "isUnrecognised" BOOLEAN NOT NULL DEFAULT false,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- This is what makes a box closed for everyone: two packers scanning the same
-- label cannot create two boxes to close independently.
CREATE UNIQUE INDEX "Package_trackingNumber_key" ON "Package"("trackingNumber");
CREATE INDEX "Package_showDate_status_idx" ON "Package"("showDate", "status");
CREATE INDEX "Package_status_idx" ON "Package"("status");
CREATE INDEX "Package_closedById_closedAt_idx" ON "Package"("closedById", "closedAt");

-- A count per stock number, not a checklist. A real box on 09/08 held stock
-- number 49746 three times; as a list of unique items the second scan of an
-- identical barcode reads as a duplicate and gets refused.
CREATE TABLE "PackageItem" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "stockNumber" TEXT NOT NULL,
    "expectedQty" INTEGER NOT NULL,
    "scannedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PackageItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PackageItem_packageId_stockNumber_key" ON "PackageItem"("packageId", "stockNumber");
CREATE INDEX "PackageItem_stockNumber_idx" ON "PackageItem"("stockNumber");

-- Neither count can go negative. scannedQty is deliberately allowed to exceed
-- expectedQty: an unexpected watch added on purpose is recorded as expected 0,
-- scanned 1, and the box is marked incomplete.
ALTER TABLE "PackageItem"
  ADD CONSTRAINT "PackageItem_expectedQty_not_negative" CHECK ("expectedQty" >= 0);
ALTER TABLE "PackageItem"
  ADD CONSTRAINT "PackageItem_scannedQty_not_negative" CHECK ("scannedQty" >= 0);

-- ---------------------------------------------------------- 6. the evidence

-- Append-only. This is what answers a customer who says they were sent the
-- wrong watch: which box, which watch, by whom, at what moment — and what was
-- refused, because a refusal is proof the control worked.
--
-- About 700 rows a day at the real rate of 220 boxes and 473 watches.
CREATE TABLE "ScanEvent" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "ScanKind" NOT NULL,
    "stockNumber" TEXT,
    "rawScan" TEXT,
    "note" TEXT,

    CONSTRAINT "ScanEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScanEvent_packageId_at_idx" ON "ScanEvent"("packageId", "at");
CREATE INDEX "ScanEvent_userId_at_idx" ON "ScanEvent"("userId", "at");
CREATE INDEX "ScanEvent_at_idx" ON "ScanEvent"("at");

-- ------------------------------------------------------- 7. foreign keys

-- SetNull on the uploader and the closer: removing somebody's account must
-- never delete the record of an upload or a shipment.
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SalesRecord" ADD CONSTRAINT "SalesRecord_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ImportDrop" ADD CONSTRAINT "ImportDrop_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A box outlives the upload that created it. Deleting a batch must not delete
-- boxes that have already been packed and closed.
ALTER TABLE "Package" ADD CONSTRAINT "Package_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Package" ADD CONSTRAINT "Package_closedById_fkey"
  FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict, not Cascade: a box that has been scanned can no longer be deleted
-- at all. Re-uploading a corrected report may drop a box nobody has touched,
-- but the moment a packer scans one it becomes evidence, and the database
-- refuses rather than trusting every future caller to remember.
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restrict, not SetNull: a scan without a name is not evidence. An account that
-- has packed a box cannot be deleted — deactivate it instead, which is what the
-- Team page already does.
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

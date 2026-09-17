-- StreamOps — the whole database, from nothing.
--
-- Equivalent to running every migration in order, and kept in step with them:
-- `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
-- produces everything down to the last section, which is added by hand.
--
-- Use this to stand up a scratch or staging database in one command. Use
-- `npm run db:deploy` for anything that already holds data — this file only
-- creates, and running it against a live database will fail on the first table
-- that already exists.
--
--   psql "$DATABASE_URL" -f prisma/schema.sql
--
-- Regenerate with scripts/build-schema-sql.mjs after adding a migration.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('EMPLOYEE', 'MANAGER', 'BOSS');

-- CreateEnum
CREATE TYPE "Team" AS ENUM ('STREAMING', 'SHIPPING');

-- CreateEnum
CREATE TYPE "Business" AS ENUM ('WATCH', 'DIAMOND');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('TIKTOK', 'EBAY');

-- CreateEnum
CREATE TYPE "Slot" AS ENUM ('DAY', 'NIGHT');

-- CreateEnum
CREATE TYPE "ShowStatus" AS ENUM ('SCHEDULED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TimeEntrySource" AS ENUM ('SELF', 'ADMIN', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('OK', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('OPEN', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE', 'CLOSED_UNVERIFIED');

-- CreateEnum
CREATE TYPE "ScanKind" AS ENUM ('LABEL', 'ITEM_ACCEPTED', 'ITEM_REFUSED', 'ITEM_OVERRIDE', 'CLOSE_COMPLETE', 'CLOSE_INCOMPLETE', 'CLOSE_UNVERIFIED', 'REOPEN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'EMPLOYEE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "team" "Team" NOT NULL DEFAULT 'STREAMING',
    "hourlyRateCents" INTEGER,
    "commissionBps" INTEGER,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
    "business" "Business" NOT NULL DEFAULT 'WATCH',
    "name" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'DRAFT',
    "dueAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "scheduleStatus" "ScheduleStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "usePriority" BOOLEAN NOT NULL DEFAULT false,
    "useProportional" BOOLEAN NOT NULL DEFAULT true,
    "maxShowsPerPerson" INTEGER,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseMember" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleasePriority" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ReleasePriority_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Show" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "business" "Business" NOT NULL DEFAULT 'WATCH',
    "date" DATE NOT NULL,
    "platform" "Platform" NOT NULL,
    "slot" "Slot" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "ShowStatus" NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Show_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "showId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seat" INTEGER NOT NULL,
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Availability" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "business" "Business" NOT NULL DEFAULT 'WATCH',
    "date" DATE NOT NULL,
    "slot" "Slot" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilitySubmission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AvailabilitySubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeOff" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "note" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleSnapshot" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessSettings" (
    "business" "Business" NOT NULL,
    "streamerHourlyCents" INTEGER NOT NULL DEFAULT 0,
    "streamerCommissionBps" INTEGER NOT NULL DEFAULT 100,
    "seatsPerShow" INTEGER NOT NULL DEFAULT 2,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessSettings_pkey" PRIMARY KEY ("business")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "streamerHourlyCents" INTEGER NOT NULL DEFAULT 0,
    "shippingHourlyCents" INTEGER NOT NULL DEFAULT 0,
    "streamerCommissionBps" INTEGER NOT NULL DEFAULT 100,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "summary" TEXT,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clockInAt" TIMESTAMP(3) NOT NULL,
    "clockOutAt" TIMESTAMP(3),
    "note" TEXT,
    "showId" TEXT,
    "source" "TimeEntrySource" NOT NULL DEFAULT 'SELF',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntryRevision" (
    "id" TEXT NOT NULL,
    "timeEntryId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "clockInAt" TIMESTAMP(3) NOT NULL,
    "clockOutAt" TIMESTAMP(3),
    "note" TEXT,
    "reason" TEXT,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntryRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "business" "Business" NOT NULL DEFAULT 'WATCH',
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

-- CreateTable
CREATE TABLE "SalesRecord" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "business" "Business" NOT NULL DEFAULT 'WATCH',
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "business" "Business" NOT NULL DEFAULT 'WATCH',
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

-- CreateTable
CREATE TABLE "PackageItem" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "stockNumber" TEXT NOT NULL,
    "expectedQty" INTEGER NOT NULL,
    "scannedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PackageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE INDEX "Release_status_startDate_idx" ON "Release"("status", "startDate");

-- CreateIndex
CREATE INDEX "Release_scheduleStatus_startDate_idx" ON "Release"("scheduleStatus", "startDate");

-- CreateIndex
CREATE INDEX "ReleaseMember_releaseId_idx" ON "ReleaseMember"("releaseId");

-- CreateIndex
CREATE INDEX "ReleaseMember_userId_idx" ON "ReleaseMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseMember_releaseId_userId_key" ON "ReleaseMember"("releaseId", "userId");

-- CreateIndex
CREATE INDEX "ReleasePriority_releaseId_idx" ON "ReleasePriority"("releaseId");

-- CreateIndex
CREATE UNIQUE INDEX "ReleasePriority_releaseId_userId_key" ON "ReleasePriority"("releaseId", "userId");

-- CreateIndex
CREATE INDEX "Show_releaseId_date_idx" ON "Show"("releaseId", "date");

-- CreateIndex
CREATE INDEX "Show_status_date_idx" ON "Show"("status", "date");

-- CreateIndex
CREATE INDEX "Show_business_date_idx" ON "Show"("business", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Show_business_date_platform_slot_key" ON "Show"("business", "date", "platform", "slot");

-- CreateIndex
CREATE INDEX "Assignment_userId_idx" ON "Assignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_showId_seat_key" ON "Assignment"("showId", "seat");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_showId_userId_key" ON "Assignment"("showId", "userId");

-- CreateIndex
CREATE INDEX "Availability_userId_releaseId_idx" ON "Availability"("userId", "releaseId");

-- CreateIndex
CREATE INDEX "Availability_releaseId_date_idx" ON "Availability"("releaseId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Availability_userId_business_date_slot_key" ON "Availability"("userId", "business", "date", "slot");

-- CreateIndex
CREATE INDEX "AvailabilitySubmission_releaseId_idx" ON "AvailabilitySubmission"("releaseId");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilitySubmission_userId_releaseId_key" ON "AvailabilitySubmission"("userId", "releaseId");

-- CreateIndex
CREATE INDEX "TimeOff_userId_startDate_endDate_idx" ON "TimeOff"("userId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "TimeOff_startDate_endDate_idx" ON "TimeOff"("startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleSnapshot_releaseId_version_key" ON "ScheduleSnapshot"("releaseId", "version");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "TimeEntry_userId_clockInAt_idx" ON "TimeEntry"("userId", "clockInAt");

-- CreateIndex
CREATE INDEX "TimeEntry_clockInAt_idx" ON "TimeEntry"("clockInAt");

-- CreateIndex
CREATE INDEX "TimeEntry_userId_clockOutAt_idx" ON "TimeEntry"("userId", "clockOutAt");

-- CreateIndex
CREATE INDEX "TimeEntry_showId_idx" ON "TimeEntry"("showId");

-- CreateIndex
CREATE INDEX "TimeEntryRevision_changedAt_idx" ON "TimeEntryRevision"("changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TimeEntryRevision_timeEntryId_version_key" ON "TimeEntryRevision"("timeEntryId", "version");

-- CreateIndex
CREATE INDEX "ImportBatch_showDate_uploadedAt_idx" ON "ImportBatch"("showDate", "uploadedAt");

-- CreateIndex
CREATE INDEX "ImportBatch_status_showDate_idx" ON "ImportBatch"("status", "showDate");

-- CreateIndex
CREATE INDEX "ImportBatch_business_showDate_uploadedAt_idx" ON "ImportBatch"("business", "showDate", "uploadedAt");

-- CreateIndex
CREATE INDEX "SalesRecord_showDate_show_idx" ON "SalesRecord"("showDate", "show");

-- CreateIndex
CREATE INDEX "SalesRecord_batchId_idx" ON "SalesRecord"("batchId");

-- CreateIndex
CREATE INDEX "SalesRecord_tracking_idx" ON "SalesRecord"("tracking");

-- CreateIndex
CREATE INDEX "SalesRecord_shiftTag_idx" ON "SalesRecord"("shiftTag");

-- CreateIndex
CREATE INDEX "SalesRecord_business_showDate_idx" ON "SalesRecord"("business", "showDate");

-- CreateIndex
CREATE INDEX "ImportDrop_batchId_idx" ON "ImportDrop"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "Package_trackingNumber_key" ON "Package"("trackingNumber");

-- CreateIndex
CREATE INDEX "Package_showDate_status_idx" ON "Package"("showDate", "status");

-- CreateIndex
CREATE INDEX "Package_status_idx" ON "Package"("status");

-- CreateIndex
CREATE INDEX "Package_closedById_closedAt_idx" ON "Package"("closedById", "closedAt");

-- CreateIndex
CREATE INDEX "Package_business_showDate_status_idx" ON "Package"("business", "showDate", "status");

-- CreateIndex
CREATE INDEX "PackageItem_stockNumber_idx" ON "PackageItem"("stockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PackageItem_packageId_stockNumber_key" ON "PackageItem"("packageId", "stockNumber");

-- CreateIndex
CREATE INDEX "ScanEvent_packageId_at_idx" ON "ScanEvent"("packageId", "at");

-- CreateIndex
CREATE INDEX "ScanEvent_userId_at_idx" ON "ScanEvent"("userId", "at");

-- CreateIndex
CREATE INDEX "ScanEvent_at_idx" ON "ScanEvent"("at");

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseMember" ADD CONSTRAINT "ReleaseMember_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseMember" ADD CONSTRAINT "ReleaseMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleasePriority" ADD CONSTRAINT "ReleasePriority_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleasePriority" ADD CONSTRAINT "ReleasePriority_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Show" ADD CONSTRAINT "Show_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_showId_fkey" FOREIGN KEY ("showId") REFERENCES "Show"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilitySubmission" ADD CONSTRAINT "AvailabilitySubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilitySubmission" ADD CONSTRAINT "AvailabilitySubmission_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSnapshot" ADD CONSTRAINT "ScheduleSnapshot_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSnapshot" ADD CONSTRAINT "ScheduleSnapshot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_showId_fkey" FOREIGN KEY ("showId") REFERENCES "Show"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntryRevision" ADD CONSTRAINT "TimeEntryRevision_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntryRevision" ADD CONSTRAINT "TimeEntryRevision_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesRecord" ADD CONSTRAINT "SalesRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportDrop" ADD CONSTRAINT "ImportDrop_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanEvent" ADD CONSTRAINT "ScanEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Guarantees Prisma's schema language cannot express
-- ===========================================================================
--
-- Everything above is generated. Everything below is written by hand, and is
-- the reason a bad row cannot exist rather than merely being unlikely: each one
-- is a rule the application also enforces, made true by the database so that a
-- future caller who forgets cannot make it false.
--
-- These live in the migrations too. If you add one there, add it here.

-- A show has two seats and no third. Seat carries no meaning beyond that — the
-- pair swap jobs halfway through — but a seat 3 would silently create a
-- three-person show.
ALTER TABLE "Assignment"
  ADD CONSTRAINT "Assignment_seat_is_one_or_two" CHECK ("seat" IN (1, 2));

-- A shift cannot end before it started.
ALTER TABLE "TimeEntry"
  ADD CONSTRAINT "TimeEntry_ends_after_it_starts"
  CHECK ("clockOutAt" IS NULL OR "clockOutAt" > "clockInAt");

-- Nobody can be clocked in twice at once. Partial, so it constrains only the
-- open entries and a person can still have any number of closed ones.
CREATE UNIQUE INDEX "TimeEntry_one_open_per_user"
  ON "TimeEntry" ("userId") WHERE "clockOutAt" IS NULL;

-- One person's hours for one show are printed once and once only. Without this,
-- two pages loading at the same moment as a show starts would each print a copy
-- and somebody would be paid twice.
CREATE UNIQUE INDEX "TimeEntry_userId_showId_scheduled_key"
  ON "TimeEntry" ("userId", "showId") WHERE "source" = 'SCHEDULE';

-- Neither count on a box can go negative. scannedQty is deliberately allowed to
-- exceed expectedQty: an unexpected watch added on purpose is recorded as
-- expected 0, scanned 1, and the box is marked incomplete.
ALTER TABLE "PackageItem"
  ADD CONSTRAINT "PackageItem_expectedQty_not_negative" CHECK ("expectedQty" >= 0);
ALTER TABLE "PackageItem"
  ADD CONSTRAINT "PackageItem_scannedQty_not_negative" CHECK ("scannedQty" >= 0);

-- A rate below zero is not a rate. Cheaper to refuse here than to find a
-- negative wage in a payroll export.
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_streamerHourlyCents_not_negative" CHECK ("streamerHourlyCents" >= 0),
  ADD CONSTRAINT "Settings_shippingHourlyCents_not_negative" CHECK ("shippingHourlyCents" >= 0),
  ADD CONSTRAINT "Settings_streamerCommissionBps_not_negative" CHECK ("streamerCommissionBps" >= 0);

ALTER TABLE "User"
  ADD CONSTRAINT "User_hourlyRateCents_not_negative"
    CHECK ("hourlyRateCents" IS NULL OR "hourlyRateCents" >= 0),
  ADD CONSTRAINT "User_commissionBps_not_negative"
    CHECK ("commissionBps" IS NULL OR "commissionBps" >= 0);

-- The same guarantees for each kind of show's own rates, plus a sensible number
-- of people on one: commission is paid per person, so seatsPerShow is what
-- decides whether a show pays out 1% of its sales or 2%.
ALTER TABLE "BusinessSettings"
  ADD CONSTRAINT "BusinessSettings_streamerHourlyCents_not_negative" CHECK ("streamerHourlyCents" >= 0),
  ADD CONSTRAINT "BusinessSettings_streamerCommissionBps_not_negative" CHECK ("streamerCommissionBps" >= 0),
  ADD CONSTRAINT "BusinessSettings_seatsPerShow_sensible" CHECK ("seatsPerShow" BETWEEN 1 AND 4);

-- A database standing up from nothing still needs both rows to exist. The
-- migration seeds watches by copying the singleton; from empty there is nothing
-- to copy, so they start on what the two actually pay.
INSERT INTO "BusinessSettings" ("business", "streamerCommissionBps", "seatsPerShow", "updatedAt")
VALUES ('WATCH', 100, 2, CURRENT_TIMESTAMP)
ON CONFLICT ("business") DO NOTHING;

INSERT INTO "BusinessSettings" ("business", "streamerHourlyCents", "streamerCommissionBps", "seatsPerShow", "updatedAt")
VALUES ('DIAMOND', 3000, 100, 2, CURRENT_TIMESTAMP)
ON CONFLICT ("business") DO NOTHING;

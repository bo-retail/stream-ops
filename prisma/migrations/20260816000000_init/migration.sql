-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('EMPLOYEE', 'BOSS');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('TIKTOK', 'EBAY');

-- CreateEnum
CREATE TYPE "SlotType" AS ENUM ('DAY', 'NIGHT');

-- CreateEnum
CREATE TYPE "WeekStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "CommissionModel" AS ENUM ('PER_SELLER', 'SPLIT_EVENLY', 'SPLIT_BY_HOURS');

-- CreateEnum
CREATE TYPE "PayPeriodType" AS ENUM ('WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY');

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

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleWeek" (
    "id" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "status" "WeekStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleWeek_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowSlot" (
    "id" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "platform" "Platform" NOT NULL,
    "slotType" "SlotType" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "hoursHundredths" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "showSlotId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Availability" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "date" DATE NOT NULL,
    "platform" "Platform" NOT NULL,
    "slotType" "SlotType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilitySubmission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AvailabilitySubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesEntry" (
    "id" TEXT NOT NULL,
    "showSlotId" TEXT NOT NULL,
    "revenueCents" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "enteredById" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesEntryRevision" (
    "id" TEXT NOT NULL,
    "salesEntryId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "revenueCents" INTEGER NOT NULL,
    "note" TEXT,
    "reason" TEXT,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesEntryRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleSnapshot" (
    "id" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "lockedById" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "baseHourlyRateCents" INTEGER NOT NULL DEFAULT 3000,
    "commissionModel" "CommissionModel" NOT NULL DEFAULT 'PER_SELLER',
    "commissionRateBps" INTEGER NOT NULL DEFAULT 100,
    "dayStreamStart" TEXT NOT NULL DEFAULT '11:00',
    "dayStreamEnd" TEXT NOT NULL DEFAULT '15:00',
    "nightStreamStart" TEXT NOT NULL DEFAULT '19:00',
    "nightStreamEnd" TEXT NOT NULL DEFAULT '23:00',
    "payPeriodType" "PayPeriodType" NOT NULL DEFAULT 'BIWEEKLY',
    "payPeriodAnchor" DATE NOT NULL,
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

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleWeek_weekStart_key" ON "ScheduleWeek"("weekStart");

-- CreateIndex
CREATE INDEX "ScheduleWeek_status_weekStart_idx" ON "ScheduleWeek"("status", "weekStart");

-- CreateIndex
CREATE INDEX "ShowSlot_date_platform_slotType_idx" ON "ShowSlot"("date", "platform", "slotType");

-- CreateIndex
CREATE UNIQUE INDEX "ShowSlot_weekId_date_platform_slotType_key" ON "ShowSlot"("weekId", "date", "platform", "slotType");

-- CreateIndex
CREATE INDEX "Assignment_userId_idx" ON "Assignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_showSlotId_userId_key" ON "Assignment"("showSlotId", "userId");

-- CreateIndex
CREATE INDEX "Availability_weekStart_idx" ON "Availability"("weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "Availability_userId_date_platform_slotType_key" ON "Availability"("userId", "date", "platform", "slotType");

-- CreateIndex
CREATE INDEX "AvailabilitySubmission_weekStart_idx" ON "AvailabilitySubmission"("weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilitySubmission_userId_weekStart_key" ON "AvailabilitySubmission"("userId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "SalesEntry_showSlotId_key" ON "SalesEntry"("showSlotId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesEntryRevision_salesEntryId_version_key" ON "SalesEntryRevision"("salesEntryId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleSnapshot_weekId_version_key" ON "ScheduleSnapshot"("weekId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_periodStart_periodEnd_key" ON "PayrollRun"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "ScheduleWeek" ADD CONSTRAINT "ScheduleWeek_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowSlot" ADD CONSTRAINT "ShowSlot_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "ScheduleWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_showSlotId_fkey" FOREIGN KEY ("showSlotId") REFERENCES "ShowSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilitySubmission" ADD CONSTRAINT "AvailabilitySubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesEntry" ADD CONSTRAINT "SalesEntry_showSlotId_fkey" FOREIGN KEY ("showSlotId") REFERENCES "ShowSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesEntry" ADD CONSTRAINT "SalesEntry_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesEntryRevision" ADD CONSTRAINT "SalesEntryRevision_salesEntryId_fkey" FOREIGN KEY ("salesEntryId") REFERENCES "SalesEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesEntryRevision" ADD CONSTRAINT "SalesEntryRevision_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSnapshot" ADD CONSTRAINT "ScheduleSnapshot_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "ScheduleWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSnapshot" ADD CONSTRAINT "ScheduleSnapshot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

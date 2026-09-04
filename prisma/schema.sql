-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('EMPLOYEE', 'BOSS');

-- CreateEnum
CREATE TYPE "Team" AS ENUM ('STREAMING', 'SHIPPING');

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
CREATE TYPE "TimeEntrySource" AS ENUM ('SELF', 'ADMIN');

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

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
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
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
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

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE INDEX "Release_status_startDate_idx" ON "Release"("status", "startDate");

-- CreateIndex
CREATE INDEX "Release_scheduleStatus_startDate_idx" ON "Release"("scheduleStatus", "startDate");

-- CreateIndex
CREATE INDEX "ReleasePriority_releaseId_idx" ON "ReleasePriority"("releaseId");

-- CreateIndex
CREATE UNIQUE INDEX "ReleasePriority_releaseId_userId_key" ON "ReleasePriority"("releaseId", "userId");

-- CreateIndex
CREATE INDEX "Show_releaseId_date_idx" ON "Show"("releaseId", "date");

-- CreateIndex
CREATE INDEX "Show_status_date_idx" ON "Show"("status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Show_date_platform_slot_key" ON "Show"("date", "platform", "slot");

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
CREATE UNIQUE INDEX "Availability_userId_date_slot_key" ON "Availability"("userId", "date", "slot");

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

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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


-- ---------------------------------------------------------------------------
-- Guarantees Prisma's schema language cannot express.
--
-- These are applied by the migration history, so `prisma migrate deploy` puts
-- them in for you. They are repeated here because this file is also used as a
-- standalone "create everything" script, and a database without them will
-- happily store a third person on a show or a shift that ends before it starts.
-- ---------------------------------------------------------------------------

-- A show is run by exactly two people, so there is no seat 3.
ALTER TABLE "Assignment"
  ADD CONSTRAINT "Assignment_seat_is_one_or_two" CHECK (seat IN (1, 2));

-- A shift cannot end before it began. NULL means still on the clock.
ALTER TABLE "TimeEntry"
  ADD CONSTRAINT "TimeEntry_ends_after_it_starts"
  CHECK ("clockOutAt" IS NULL OR "clockOutAt" > "clockInAt");

-- One person can only be clocked in once at a time. A partial unique index, so
-- any number of closed entries are fine but only one may be open.
CREATE UNIQUE INDEX "TimeEntry_one_open_per_user"
  ON "TimeEntry" ("userId") WHERE "clockOutAt" IS NULL;

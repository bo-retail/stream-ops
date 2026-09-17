-- Diamonds sell through the same app, as shows on the same schedule.
--
-- Not a second app, not a second database, no second sidebar. The company runs
-- one team, one packing table and one payroll; what it now runs is two kinds of
-- show. A release picks which kind it is, and everything in it follows.
--
-- WHAT FORCES A COLUMN AT ALL
--
-- Both sell on TikTok, under separate seller accounts, at the same hours: on
-- 09/15 the diamond show ran 10:32–16:01 Pacific against the watch day show's
-- 10:06–16:05. So "TikTok Day on the 16th" names two different shows and
-- nothing else on the row can separate them. `Show_date_platform_slot_key`
-- allowed exactly one of them to exist; the second one saved would have been
-- refused by the database with nothing in the app able to explain why.
--
-- The key gains the business, which is a relaxation — every row today is a
-- watch row, so no existing pair can collide.
--
-- WHICH FILE IS WHICH
--
-- A TikTok export names its own shop in `Creator Handle`: `vaultshowlive` is
-- watches, `caratclublive` is diamonds. That is what places an upload, because
-- the clock cannot. An eBay export names no seller anywhere in its 82 columns,
-- so while only watches sell on eBay, an eBay file is a watch file — and if
-- diamonds ever sell there, this is the thing that will need solving first.
--
-- WHY EVERY COLUMN IS DEFAULTED
--
-- Every row that exists predates diamonds and is a watch row. Defaulting lets
-- the column arrive without editing a single call site in the same change, so
-- this can be applied and verified on its own. The default is temporary and is
-- the one unsafe thing here: while it stands, a caller that forgets its
-- business writes a watch row silently. It comes off when the business becomes
-- a required argument.
--
-- Additive otherwise: nothing dropped, no row rewritten, two indexes replaced
-- by wider ones that contain them.

-- CreateEnum
--
-- CREATE TYPE, not ALTER TYPE ... ADD VALUE, so the value may be used in the
-- same transaction that defines it.
CREATE TYPE "Business" AS ENUM ('WATCH', 'DIAMOND');

-- AlterTable — the business on everything that belongs to one kind of show.
--
-- Denormalised onto Show, Availability and SalesRecord rather than reached
-- through the release: two of them need it inside a unique key, which a join
-- cannot provide, and sales are read per business on paths that run on every
-- page.
ALTER TABLE "Release"      ADD COLUMN IF NOT EXISTS "business" "Business" NOT NULL DEFAULT 'WATCH';
ALTER TABLE "Show"         ADD COLUMN IF NOT EXISTS "business" "Business" NOT NULL DEFAULT 'WATCH';
ALTER TABLE "Availability" ADD COLUMN IF NOT EXISTS "business" "Business" NOT NULL DEFAULT 'WATCH';
ALTER TABLE "ImportBatch"  ADD COLUMN IF NOT EXISTS "business" "Business" NOT NULL DEFAULT 'WATCH';
ALTER TABLE "SalesRecord"  ADD COLUMN IF NOT EXISTS "business" "Business" NOT NULL DEFAULT 'WATCH';
ALTER TABLE "Package"      ADD COLUMN IF NOT EXISTS "business" "Business" NOT NULL DEFAULT 'WATCH';

-- Deliberately NOT on TimeEntry or User.
--
-- Nobody clocks in "against diamonds": a streamer's hours come from the show
-- they were on, which knows, and a packer handles both piles in one shift off
-- one table. And nobody *is* a diamond streamer — a release says who works it,
-- and that can differ from one fortnight to the next.

-- DropIndex / CreateIndex — the two keys that gain the business.
--
-- Availability for the same reason as Show: a watch release and a diamond
-- release covering the same fortnight would collide the moment somebody was on
-- both and answered both.
DROP INDEX IF EXISTS "Show_date_platform_slot_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Show_business_date_platform_slot_key"
  ON "Show" ("business", "date", "platform", "slot");

DROP INDEX IF EXISTS "Availability_userId_date_slot_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Availability_userId_business_date_slot_key"
  ON "Availability" ("userId", "business", "date", "slot");

-- CreateIndex — the reads that are now always filtered by business.
CREATE INDEX IF NOT EXISTS "Show_business_date_idx"
  ON "Show" ("business", "date");
CREATE INDEX IF NOT EXISTS "ImportBatch_business_showDate_uploadedAt_idx"
  ON "ImportBatch" ("business", "showDate", "uploadedAt");
CREATE INDEX IF NOT EXISTS "SalesRecord_business_showDate_idx"
  ON "SalesRecord" ("business", "showDate");
CREATE INDEX IF NOT EXISTS "Package_business_showDate_status_idx"
  ON "Package" ("business", "showDate", "status");

-- CreateTable — who a release is for.
--
-- Two things at once, deliberately: the people asked for their availability,
-- and the only people who may be seated on its shows. One list means "why is
-- she not in the picker" always answers "she is not on the release", rather
-- than two settings that can disagree.
--
-- No backfill. An empty list reads as everybody, which is exactly what every
-- release created before today did — so historical releases keep working
-- untouched, and the composer refuses to send a new one to nobody.
CREATE TABLE IF NOT EXISTS "ReleaseMember" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReleaseMember_releaseId_userId_key"
  ON "ReleaseMember" ("releaseId", "userId");
CREATE INDEX IF NOT EXISTS "ReleaseMember_releaseId_idx" ON "ReleaseMember" ("releaseId");
CREATE INDEX IF NOT EXISTS "ReleaseMember_userId_idx" ON "ReleaseMember" ("userId");

ALTER TABLE "ReleaseMember"
  ADD CONSTRAINT "ReleaseMember_releaseId_fkey" FOREIGN KEY ("releaseId")
  REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReleaseMember"
  ADD CONSTRAINT "ReleaseMember_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable — what each kind of show pays, and how many people run one.
--
-- Split out of Settings because these are exactly the things that differ. The
-- timezone stays shared: one company, one place.
--
-- Shipping's hourly rate is deliberately absent. Packers handle both piles in
-- one shift and never clock against a show, so there is nothing to attribute
-- their hours to — they stay on the one blended rate in Settings.
CREATE TABLE IF NOT EXISTS "BusinessSettings" (
    "business" "Business" NOT NULL,
    "streamerHourlyCents" INTEGER NOT NULL DEFAULT 0,
    "streamerCommissionBps" INTEGER NOT NULL DEFAULT 100,
    -- Two on the watch side, where the pair split camera and computer and swap
    -- halfway; a diamond show may run with one. A number rather than a constant
    -- because commission is paid per person, so this decides whether a show
    -- pays out 1% of its sales or 2%.
    "seatsPerShow" INTEGER NOT NULL DEFAULT 2,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessSettings_pkey" PRIMARY KEY ("business")
);

-- A rate below zero is not a rate, and a show run by nobody is not a show.
-- Cheaper to refuse here than to find a negative wage in a payroll export.
ALTER TABLE "BusinessSettings"
  ADD CONSTRAINT "BusinessSettings_streamerHourlyCents_not_negative" CHECK ("streamerHourlyCents" >= 0),
  ADD CONSTRAINT "BusinessSettings_streamerCommissionBps_not_negative" CHECK ("streamerCommissionBps" >= 0),
  ADD CONSTRAINT "BusinessSettings_seatsPerShow_sensible" CHECK ("seatsPerShow" BETWEEN 1 AND 4);

-- Watches start on exactly what is being paid today, copied from the singleton
-- rather than typed again here, so nobody's pay moves by a cent when the
-- readers switch over.
INSERT INTO "BusinessSettings" ("business", "streamerHourlyCents", "streamerCommissionBps", "seatsPerShow", "updatedAt")
SELECT 'WATCH', "streamerHourlyCents", "streamerCommissionBps", 2, CURRENT_TIMESTAMP
  FROM "Settings" WHERE "id" = 'singleton'
ON CONFLICT ("business") DO NOTHING;

-- And from an empty database there is nothing to copy.
INSERT INTO "BusinessSettings" ("business", "seatsPerShow", "updatedAt")
VALUES ('WATCH', 2, CURRENT_TIMESTAMP)
ON CONFLICT ("business") DO NOTHING;

-- Diamonds open on $30 an hour and 1% a person, which is what they pay. Seats
-- stay at two, the safe assumption: a one-person show pays half the commission,
-- so guessing that way round would underpay somebody quietly.
INSERT INTO "BusinessSettings" ("business", "streamerHourlyCents", "streamerCommissionBps", "seatsPerShow", "updatedAt")
VALUES ('DIAMOND', 3000, 100, 2, CURRENT_TIMESTAMP)
ON CONFLICT ("business") DO NOTHING;

-- A day is a checklist of files, not one report.
--
-- Until now an upload was the day: a second one replaced everything the first
-- had written, and open boxes it did not mention were removed. That is why
-- uploading a single missing file was dangerous, and why a guard had to exist
-- to stop somebody doing it.
--
-- A day is really a list of separate exports — one per TikTok show, one per
-- business selling on eBay — each produced at a different moment and each ready
-- at a different time. So an upload becomes one file, and these two columns say
-- which line of the list it fills. Re-uploading a corrected TikTok night file
-- then replaces the TikTok night file and nothing else.
--
-- Null on both where the upload was refused before anything could be read, and
-- `slot` is null for eBay, whose single export covers the whole day however
-- many eBay shows ran.
--
-- BACKFILL
--
-- Not here. Every batch already on record was written under the old model, one
-- upload holding the whole day, and is left null by this file. The migration
-- that follows assigns them — from each sale's own `show` column, which the
-- import had already decided, so nothing about it is a guess.
--
-- SUPERSEDED
--
-- Under the old model a day read only its newest upload; earlier ones stayed on
-- record and were simply never read. Under the new one, a day reads the newest
-- upload of each line. Translating the first into the second faithfully means
-- marking those earlier uploads as history outright, so that none of them can
-- become the "newest" of a line the day's last upload happened not to carry.
-- The next migration does the marking; the value has to exist first, and in a
-- file of its own, because PostgreSQL will not let a value added in a
-- transaction be used in that same transaction.
--
-- Additive: two nullable columns, one index and one enum value. No row
-- rewritten, nothing dropped, and every statement safe to run twice.

ALTER TABLE "ImportBatch" ADD COLUMN IF NOT EXISTS "platform" "Platform";
ALTER TABLE "ImportBatch" ADD COLUMN IF NOT EXISTS "slot" "Slot";

ALTER TYPE "ImportStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';

-- Finding the latest upload for one line of a day's checklist.
CREATE INDEX IF NOT EXISTS "ImportBatch_showDate_business_platform_slot_uploadedAt_idx"
  ON "ImportBatch" ("showDate", "business", "platform", "slot", "uploadedAt");

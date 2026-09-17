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
-- Every batch already on record was written under the old model: one upload
-- holding the whole day. Those are deliberately left null rather than guessed
-- at. A historical batch's `files` JSON lists what it contained, and splitting
-- one retrospectively would mean inventing which of its sales belonged to which
-- line — a guess, in a table payroll reads. Read as one upload covering the
-- day, which is exactly what they were.
--
-- Additive: two nullable columns and one index. No row rewritten, nothing
-- dropped, and every statement safe to run twice.

ALTER TABLE "ImportBatch" ADD COLUMN IF NOT EXISTS "platform" "Platform";
ALTER TABLE "ImportBatch" ADD COLUMN IF NOT EXISTS "slot" "Slot";

-- Finding the latest upload for one line of a day's checklist.
CREATE INDEX IF NOT EXISTS "ImportBatch_showDate_business_platform_slot_uploadedAt_idx"
  ON "ImportBatch" ("showDate", "business", "platform", "slot", "uploadedAt");

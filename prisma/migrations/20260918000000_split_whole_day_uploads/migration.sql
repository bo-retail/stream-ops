-- Splits every upload made under the old model into the lines it really held.
--
-- WHY THIS CANNOT BE SKIPPED
--
-- Until the previous migration an upload was the whole day: one batch holding
-- every file, with no record of which line each part came from. Uploads from
-- now on are one file each and supersede only their own line.
--
-- Those two shapes cannot sit on the same day. A batch with no line matches no
-- line, so it supersedes nothing and nothing supersedes it — and the day then
-- reads BOTH. Re-uploading one corrected file for a day loaded before the
-- deploy adds its sales on top of the copy already there. Measured on the real
-- 09/14 exports: 591 sales became 856, and that show's pair would have been
-- paid commission on their takings twice.
--
-- So every old batch is split here, once, and afterwards every upload in the
-- table is line-scoped. Nothing downstream has to know the old shape ever
-- existed.
--
-- WHAT IT DOES
--
-- For each line an old batch actually holds — one per TikTok show, one per
-- seller account on eBay — the first keeps the original batch and the rest get
-- a copy of it. Sales move to whichever line they belong to, read from the
-- `show` column that ingestion already decided. Counts and the file list are
-- rebuilt from what each line ends up holding, so a split batch describes
-- itself honestly rather than still claiming the whole day.
--
-- Boxes are deliberately left pointing at the original batch. A box can hold
-- watches from two shows, so it belongs to no single line — and box removal is
-- matched against the whole day's tracking numbers, so a box that is still sold
-- somewhere on the day survives whichever line is re-uploaded.
--
-- Nothing is deleted. A batch with no sales at all — a day where everything was
-- cancelled — has no lines to split into and is left exactly as it is.

DO $$
DECLARE
  batch   RECORD;
  line    RECORD;
  is_first BOOLEAN;
  seen_platform TEXT;
  new_id  TEXT;
BEGIN
  FOR batch IN
    SELECT id, business, "showDate", "uploadedById", "uploadedAt", files, flags
      FROM "ImportBatch"
     WHERE status = 'OK' AND platform IS NULL
  LOOP
    is_first := TRUE;
    seen_platform := NULL;

    FOR line IN
      SELECT s.platform AS platform,
             CASE WHEN s.platform = 'EBAY' THEN NULL
                  WHEN s."show" LIKE '%AM'  THEN 'DAY'::"Slot"
                  ELSE 'NIGHT'::"Slot"
             END AS slot
        FROM "SalesRecord" s
       WHERE s."batchId" = batch.id
       GROUP BY 1, 2
       ORDER BY 1, 2
    LOOP
      IF is_first THEN
        -- The first line keeps the original batch, so its id, its uploader and
        -- its place in history are all preserved.
        UPDATE "ImportBatch"
           SET platform = line.platform, slot = line.slot
         WHERE id = batch.id;
        new_id := batch.id;
        is_first := FALSE;
      ELSE
        new_id := batch.id || '-' || line.platform || COALESCE('-' || line.slot::text, '');

        INSERT INTO "ImportBatch" (
          id, business, platform, slot, "showDate", status,
          "uploadedById", "uploadedAt", files, flags,
          "watchCount", "boxCount", "droppedCount"
        )
        VALUES (
          new_id, batch.business, line.platform, line.slot, batch."showDate", 'OK',
          batch."uploadedById", batch."uploadedAt", batch.files, batch.flags,
          0, 0, 0
        )
        ON CONFLICT (id) DO NOTHING;

        UPDATE "SalesRecord"
           SET "batchId" = new_id
         WHERE "batchId" = batch.id
           AND platform = line.platform
           AND (
             (line.slot IS NULL)
             OR ((CASE WHEN "show" LIKE '%AM' THEN 'DAY' ELSE 'NIGHT' END)::"Slot" = line.slot)
           );
      END IF;

      -- A dropped row records its marketplace but not which show it was in, so
      -- it goes to the first line of its own platform. It is the exceptions
      -- list, not anything anybody is paid from.
      IF seen_platform IS DISTINCT FROM line.platform::text THEN
        UPDATE "ImportDrop"
           SET "batchId" = new_id
         WHERE "batchId" = batch.id AND platform = line.platform;
        seen_platform := line.platform::text;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Rebuild each batch's own figures from what it actually ended up holding, and
-- its file list from the files its sales came out of — so a split batch names
-- its own export rather than all three.
UPDATE "ImportBatch" b
   SET "watchCount"   = COALESCE((SELECT count(*)                       FROM "SalesRecord" s WHERE s."batchId" = b.id), 0),
       "boxCount"     = COALESCE((SELECT count(DISTINCT s.tracking)     FROM "SalesRecord" s WHERE s."batchId" = b.id AND s.tracking <> ''), 0),
       "droppedCount" = COALESCE((SELECT count(*)                       FROM "ImportDrop"  d WHERE d."batchId" = b.id), 0),
       files          = COALESCE(
                          (SELECT jsonb_agg(DISTINCT jsonb_build_object('name', s."sourceFile", 'platform', s.platform::text))
                             FROM "SalesRecord" s WHERE s."batchId" = b.id),
                          b.files
                        )
 WHERE b.status = 'OK' AND b.platform IS NOT NULL;

-- Carries every day loaded under the old model into the new one, without
-- changing a cent of what any day reads.
--
-- THE TWO MODELS
--
-- Old: an upload was the whole day, and a day read only its newest upload.
-- Earlier uploads stayed on record and were simply never read.
--
-- New: an upload is one file — one line of the day's checklist — and a day
-- reads the newest upload of each line, all of them at once.
--
-- WHY THIS CANNOT BE SKIPPED
--
-- An old upload has no line, so under the new rule it matches nothing: it
-- supersedes nothing and nothing supersedes it, and the day reads it AND
-- whatever is uploaded for that day afterwards. Measured on the real 09/14
-- exports, re-uploading one corrected file turned 591 sales into 856, and that
-- show's pair would have been paid commission on their takings twice.
--
-- WHAT IT DOES
--
-- 1. For each day, every old upload except the newest is marked SUPERSEDED.
--    That is exactly what the old model already did with them — never read
--    them — made explicit, so none can become the newest copy of a line that
--    the day's last upload happened not to carry. Without this, a night file
--    left out of a re-upload would quietly come back, and a day already paid
--    on would change.
--
-- 2. The newest old upload of each day is split into the lines it really holds
--    — one per TikTok show, one per seller account on eBay. The first line
--    keeps the original batch; the rest get a copy of it. Sales move to the
--    line they belong to, read from the `show` column the import had already
--    decided: "TikTok AM" and "TikTok PM", "eBay AM" and "eBay PM", the only
--    four values ever written.
--
-- 3. Each split batch's figures and file list are rebuilt from what it now
--    holds. File entries are kept as they were written, fingerprint and all,
--    and filtered to the files whose sales the line holds.
--
-- So after this, a day reads the union of its newest upload's lines — which is
-- its newest upload — which is what it read before. By construction.
--
-- Boxes are deliberately left pointing where they point. A box can hold watches
-- from two shows, so it belongs to no single line, and clearing out a box on a
-- later re-upload is decided against the whole day's current reports rather
-- than against the batch the box happens to name.
--
-- Nothing is deleted. A batch with no sales at all — a day where every order
-- was cancelled — has no lines to split into and is left as it is.

-- 1. Earlier uploads of a day: history, as they always were.
UPDATE "ImportBatch" b
   SET status = 'SUPERSEDED'
 WHERE b.status = 'OK'
   AND b.platform IS NULL
   AND EXISTS (
     SELECT 1
       FROM "ImportBatch" n
      WHERE n.status = 'OK'
        AND n.platform IS NULL
        AND n.business = b.business
        AND n."showDate" = b."showDate"
        AND (n."uploadedAt" > b."uploadedAt"
             OR (n."uploadedAt" = b."uploadedAt" AND n.id > b.id))
   );

-- 2 and 3. The newest upload of each day, split into its lines.
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

    -- Each line's own figures, from what it now holds. Only the batches this
    -- split made — the original and its copies, whose ids extend it — so
    -- nothing written any other way is touched.
    UPDATE "ImportBatch" b
       SET "watchCount"   = COALESCE((SELECT sum(s.qty)                 FROM "SalesRecord" s WHERE s."batchId" = b.id), 0),
           "boxCount"     = COALESCE((SELECT count(DISTINCT s.tracking) FROM "SalesRecord" s WHERE s."batchId" = b.id AND s.tracking <> ''), 0),
           "droppedCount" = COALESCE((SELECT count(*)                   FROM "ImportDrop"  d WHERE d."batchId" = b.id), 0),
           files          = COALESCE(
                              -- The entries as written, for the files this line's sales came from.
                              (SELECT jsonb_agg(f)
                                 FROM jsonb_array_elements(
                                        CASE WHEN jsonb_typeof(b.files) = 'array' THEN b.files ELSE '[]'::jsonb END
                                      ) f
                                WHERE f->>'name' IN (SELECT s."sourceFile" FROM "SalesRecord" s WHERE s."batchId" = b.id)),
                              -- Should a file list not name them, say which files they were.
                              (SELECT jsonb_agg(DISTINCT jsonb_build_object('name', s."sourceFile", 'platform', s.platform::text))
                                 FROM "SalesRecord" s WHERE s."batchId" = b.id),
                              b.files
                            )
     WHERE b.status = 'OK'
       AND b.platform IS NOT NULL
       AND (b.id = batch.id OR b.id LIKE batch.id || '-%');
  END LOOP;
END $$;

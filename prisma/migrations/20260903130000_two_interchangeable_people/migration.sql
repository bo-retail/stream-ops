-- The two people on a show are interchangeable: they split it between camera
-- and computer and swap halfway. So an assignment no longer carries a job.
--
-- Written by hand rather than generated, so existing assignments survive:
-- `position` is converted to a meaningless seat number instead of being dropped
-- and recreated.

-- Assignment: position -> seat
ALTER TABLE "Assignment" ADD COLUMN "seat" INTEGER;

UPDATE "Assignment" SET "seat" = CASE WHEN "position" = 'STREAMER' THEN 1 ELSE 2 END;

ALTER TABLE "Assignment" ALTER COLUMN "seat" SET NOT NULL;

DROP INDEX IF EXISTS "Assignment_showId_position_key";

ALTER TABLE "Assignment" DROP COLUMN "position";

CREATE UNIQUE INDEX "Assignment_showId_seat_key" ON "Assignment"("showId", "seat");

-- Stops one person being counted as both people on a show. Application code
-- alone could never guarantee this against concurrent edits.
CREATE UNIQUE INDEX "Assignment_showId_userId_key" ON "Assignment"("showId", "userId");

-- Availability: people say when they are free, not which job they want.
ALTER TABLE "Availability" DROP COLUMN "position";

DROP TYPE "Position";

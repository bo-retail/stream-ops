-- A release can run any number of shows a day, not just a day and a night.
--
-- `slot` was an enum of DAY and NIGHT. It becomes text so an extra show can be
-- kept under the name the boss gave it ("EARLY AM"). Nothing already stored
-- changes: every existing row keeps exactly 'DAY' or 'NIGHT', which is what
-- the enum value reads as text. The unique keys and indexes on these columns
-- are rebuilt by Postgres as part of the type change and mean what they did.

ALTER TABLE "Show" ALTER COLUMN "slot" TYPE TEXT USING "slot"::text;
ALTER TABLE "Availability" ALTER COLUMN "slot" TYPE TEXT USING "slot"::text;
ALTER TABLE "ImportBatch" ALTER COLUMN "slot" TYPE TEXT USING "slot"::text;

DROP TYPE "Slot";

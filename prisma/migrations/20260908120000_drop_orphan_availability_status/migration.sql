-- Drops the AvailabilityStatus enum, which nothing uses any more.
--
-- The releases migration replaced the column that used it (Release.status is a
-- ReleaseStatus now) but dropped only the column, not the type. An orphan type
-- is harmless at runtime, but it makes `prisma migrate diff` report drift
-- between a freshly migrated database and the schema — which is exactly the
-- signal a developer needs to be able to trust when setting one up.
--
-- Guarded, so it is safe on a database where it was already gone.
DROP TYPE IF EXISTS "AvailabilityStatus";

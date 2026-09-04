-- A show is run by exactly two people. The unique index on (showId, seat) stops
-- a seat being filled twice, but nothing stopped a third row with seat = 3.
--
-- Prisma has no syntax for a CHECK constraint, so it is added here by hand. It
-- is invisible to the schema file but real in the database, which is where the
-- guarantee has to live.
ALTER TABLE "Assignment"
  ADD CONSTRAINT "Assignment_seat_is_one_or_two" CHECK ("seat" IN (1, 2));

-- Streamers stop clocking for their shows.
--
-- Being on a published schedule is the commitment: if somebody is on it and it
-- has gone out, they are working it. So the hours are written from the schedule
-- as the show starts, rather than waiting for two button presses that only ever
-- reproduced the same figure — or failed to, and cost somebody their pay.
--
-- What this changes:
--
--   TimeEntrySource gains SCHEDULE, for an entry printed from the schedule
--   rather than clocked by a person or typed by an admin.
--
--   A partial unique index makes those entries idempotent. Two pages loading at
--   the same moment as a show starts would otherwise each print a copy, and
--   somebody would be paid twice for one show.
--
-- What this does NOT change:
--
--   Shipping. They have no schedule and never did; they clock, and they are
--   paid exactly what the clock says.
--
--   Anything already recorded. Every existing entry keeps its source, its
--   times, its revisions and the way its paid hours are worked out. Past
--   periods are already paid and are not rewritten by a migration.
--
-- Note on the enum: ALTER TYPE ... ADD VALUE may run inside a transaction on
-- PostgreSQL 12+, but the new value cannot be *used* until that transaction
-- commits. The index below does not use it as a value, only as a predicate on
-- existing rows, so this is safe. If your client objects, run the ALTER on its
-- own first.

ALTER TYPE "TimeEntrySource" ADD VALUE IF NOT EXISTS 'SCHEDULE';

-- One person's hours for one show, printed once and once only.
--
-- Partial, so it constrains nothing else: a person can still have any number of
-- clocked entries, with or without a show attached, and the historical ones are
-- untouched.
CREATE UNIQUE INDEX IF NOT EXISTS "TimeEntry_userId_showId_scheduled_key"
  ON "TimeEntry" ("userId", "showId")
  WHERE "source" = 'SCHEDULE';

-- A day's parcels that went out without being scanned here.
--
-- The app cannot pack a day that has already shipped, and it should not pretend
-- to. Two situations produce one:
--
--   Starting up.  The reports for the days before StreamOps had a packing
--                 screen still want loading, for the sales and the commission.
--                 Their boxes would otherwise sit open forever, and the log
--                 would read "0 sent of 220" for those days permanently.
--
--   A bad day.    The scanner dies, the wifi drops, or nobody remembers to use
--                 it. The parcels still went out. Somebody has to be able to
--                 say so without scanning six hundred labels after the fact.
--
-- This is a third closed state rather than reusing one of the two that exist.
-- CLOSED_COMPLETE means somebody scanned every watch in and they matched;
-- CLOSED_INCOMPLETE means it went out short or with something added against the
-- report. Marking an unscanned box as either is a lie about the only record
-- that answers a customer dispute, and the whole point of the scan log is that
-- it does not lie.
--
-- Purely additive: two enum values, nothing dropped, no row rewritten. Every
-- box already on record keeps the status it has.
--
-- Note on enums: PostgreSQL will not let a value added in a transaction be
-- *used* in that same transaction. Nothing below uses either of these, so this
-- is safe. If your client objects, run each ALTER on its own.

ALTER TYPE "PackageStatus" ADD VALUE IF NOT EXISTS 'CLOSED_UNVERIFIED';

-- The matching line in the box's own history, so "why is this box closed with
-- no scans in it" is answerable from the scan record itself rather than only
-- from the audit log.
ALTER TYPE "ScanKind" ADD VALUE IF NOT EXISTS 'CLOSE_UNVERIFIED';

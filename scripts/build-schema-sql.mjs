/** Rebuilds prisma/schema.sql: generated DDL plus the hand-written guarantees. */
import { readFileSync, writeFileSync } from "node:fs";

// The byte-order mark PowerShell's `>` leaves on the generated file is a syntax
// error to psql, and it lands in the middle of the file once a header is added
// in front of it. Strip it rather than depending on how the caller redirected.
const generated = readFileSync(process.argv[2], "utf8")
  .replace(/^﻿/, "")
  .replace(/\r\n/g, "\n")
  .trimEnd();

const header = `-- StreamOps — the whole database, from nothing.
--
-- Equivalent to running every migration in order, and kept in step with them:
-- \`prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script\`
-- produces everything down to the last section, which is added by hand.
--
-- Use this to stand up a scratch or staging database in one command. Use
-- \`npm run db:deploy\` for anything that already holds data — this file only
-- creates, and running it against a live database will fail on the first table
-- that already exists.
--
--   psql "$DATABASE_URL" -f prisma/schema.sql
--
-- Regenerate with scripts/build-schema-sql.mjs after adding a migration.

`;

const handWritten = `

-- ===========================================================================
-- Guarantees Prisma's schema language cannot express
-- ===========================================================================
--
-- Everything above is generated. Everything below is written by hand, and is
-- the reason a bad row cannot exist rather than merely being unlikely: each one
-- is a rule the application also enforces, made true by the database so that a
-- future caller who forgets cannot make it false.
--
-- These live in the migrations too. If you add one there, add it here.

-- A show has two seats and no third. Seat carries no meaning beyond that — the
-- pair swap jobs halfway through — but a seat 3 would silently create a
-- three-person show.
ALTER TABLE "Assignment"
  ADD CONSTRAINT "Assignment_seat_is_one_or_two" CHECK ("seat" IN (1, 2));

-- A shift cannot end before it started.
ALTER TABLE "TimeEntry"
  ADD CONSTRAINT "TimeEntry_ends_after_it_starts"
  CHECK ("clockOutAt" IS NULL OR "clockOutAt" > "clockInAt");

-- Nobody can be clocked in twice at once. Partial, so it constrains only the
-- open entries and a person can still have any number of closed ones.
CREATE UNIQUE INDEX "TimeEntry_one_open_per_user"
  ON "TimeEntry" ("userId") WHERE "clockOutAt" IS NULL;

-- One person's hours for one show are printed once and once only. Without this,
-- two pages loading at the same moment as a show starts would each print a copy
-- and somebody would be paid twice.
CREATE UNIQUE INDEX "TimeEntry_userId_showId_scheduled_key"
  ON "TimeEntry" ("userId", "showId") WHERE "source" = 'SCHEDULE';

-- Neither count on a box can go negative. scannedQty is deliberately allowed to
-- exceed expectedQty: an unexpected watch added on purpose is recorded as
-- expected 0, scanned 1, and the box is marked incomplete.
ALTER TABLE "PackageItem"
  ADD CONSTRAINT "PackageItem_expectedQty_not_negative" CHECK ("expectedQty" >= 0);
ALTER TABLE "PackageItem"
  ADD CONSTRAINT "PackageItem_scannedQty_not_negative" CHECK ("scannedQty" >= 0);

-- A rate below zero is not a rate. Cheaper to refuse here than to find a
-- negative wage in a payroll export.
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_streamerHourlyCents_not_negative" CHECK ("streamerHourlyCents" >= 0),
  ADD CONSTRAINT "Settings_shippingHourlyCents_not_negative" CHECK ("shippingHourlyCents" >= 0),
  ADD CONSTRAINT "Settings_streamerCommissionBps_not_negative" CHECK ("streamerCommissionBps" >= 0);

ALTER TABLE "User"
  ADD CONSTRAINT "User_hourlyRateCents_not_negative"
    CHECK ("hourlyRateCents" IS NULL OR "hourlyRateCents" >= 0),
  ADD CONSTRAINT "User_commissionBps_not_negative"
    CHECK ("commissionBps" IS NULL OR "commissionBps" >= 0);

-- The same guarantee for each kind of show's own rate.
ALTER TABLE "BusinessSettings"
  ADD CONSTRAINT "BusinessSettings_streamerCommissionBps_not_negative" CHECK ("streamerCommissionBps" >= 0);

-- A database standing up from nothing still needs both rows to exist. The
-- migration seeds watches by copying the singleton; from empty there is nothing
-- to copy, so they start on what the two actually pay.
INSERT INTO "BusinessSettings" ("business", "streamerCommissionBps", "updatedAt")
VALUES ('WATCH', 100, CURRENT_TIMESTAMP)
ON CONFLICT ("business") DO NOTHING;

INSERT INTO "BusinessSettings" ("business", "streamerCommissionBps", "updatedAt")
VALUES ('DIAMOND', 100, CURRENT_TIMESTAMP)
ON CONFLICT ("business") DO NOTHING;
`;

writeFileSync(process.argv[3], header + generated + handWritten, "utf8");
console.log(`Wrote ${process.argv[3]}`);

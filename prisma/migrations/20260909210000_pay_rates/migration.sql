-- What people are paid.
--
-- Everyone earns an hourly rate. A streamer earns a share of their show's sales
-- on top of it — both people on a show earn it separately, so a show at 1% pays
-- out 2% of its sales in total.
--
-- Purely additive: five nullable-or-defaulted columns, no table altered in a way
-- that touches an existing row, nothing dropped or renamed. Every rate starts at
-- zero except the commission, which starts at the 1% the business already works
-- to, so nothing is silently paid until the rates are set on the Payroll tab.
--
-- Money is whole cents and the commission is basis points (100 = 1.00%), for
-- the same reason hours are integer minutes: a rate that gets multiplied and
-- totalled must not be a float.

ALTER TABLE "Settings"
  ADD COLUMN IF NOT EXISTS "streamerHourlyCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "shippingHourlyCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "streamerCommissionBps" INTEGER NOT NULL DEFAULT 100;

-- Somebody's own rate, when it differs from their team's. Null is the normal
-- case and means "whatever the team is paid", so a change to the default moves
-- everybody who has not been given a rate of their own.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "hourlyRateCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "commissionBps" INTEGER;

-- A rate below zero is not a rate. Cheaper to refuse here than to find a
-- negative wage in an export.
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_streamerHourlyCents_not_negative" CHECK ("streamerHourlyCents" >= 0),
  ADD CONSTRAINT "Settings_shippingHourlyCents_not_negative" CHECK ("shippingHourlyCents" >= 0),
  ADD CONSTRAINT "Settings_streamerCommissionBps_not_negative" CHECK ("streamerCommissionBps" >= 0);

ALTER TABLE "User"
  ADD CONSTRAINT "User_hourlyRateCents_not_negative" CHECK ("hourlyRateCents" IS NULL OR "hourlyRateCents" >= 0),
  ADD CONSTRAINT "User_commissionBps_not_negative" CHECK ("commissionBps" IS NULL OR "commissionBps" >= 0);

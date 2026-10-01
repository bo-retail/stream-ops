-- A streamer's hourly rate, set separately for watch shows and diamond shows.
--
-- Until now one streamer rate lived on Settings and covered every show. The
-- boss wants a diamond streamer paid a different hourly from a watch streamer,
-- the same way the two commissions are already set apart, so the rate moves
-- onto BusinessSettings beside the commission.
--
-- Both rows start on exactly what streamers are paid today, copied from the
-- singleton rather than typed here, so nobody's pay moves by a cent when this
-- runs. The two only differ once somebody changes one on the Payroll screen.
--
-- Settings.streamerHourlyCents stays, kept equal to the watch rate by the
-- rates form, as the fallback if a business row were ever missing.
--
-- Purely additive: one column with a default, nothing dropped.

ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "streamerHourlyCents" INTEGER NOT NULL DEFAULT 0;

UPDATE "BusinessSettings" b
   SET "streamerHourlyCents" = s."streamerHourlyCents"
  FROM "Settings" s
 WHERE s."id" = 'singleton';

-- A wage below zero is not a wage.
DO $$ BEGIN
  ALTER TABLE "BusinessSettings"
    ADD CONSTRAINT "BusinessSettings_streamerHourlyCents_not_negative" CHECK ("streamerHourlyCents" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

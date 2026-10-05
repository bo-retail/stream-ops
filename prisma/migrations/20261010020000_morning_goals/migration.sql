-- Inventory, step 6: the morning numbers' goal, editable on the screen. Two new
-- columns with defaults ($35,000 a day at 35%); nothing else touched.

-- AlterTable
ALTER TABLE "BusinessSettings" ADD COLUMN     "dailyGoalCents" INTEGER NOT NULL DEFAULT 3500000,
ADD COLUMN     "marginGoalBps" INTEGER NOT NULL DEFAULT 3500;

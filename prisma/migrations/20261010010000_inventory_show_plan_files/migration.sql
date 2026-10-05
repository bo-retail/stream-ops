-- Inventory, step 5: remember which of the day's files were downloaded and what
-- each listed, so a later change never lists a watch twice. One new column.

-- AlterTable
ALTER TABLE "ShowPlan" ADD COLUMN     "files" JSONB NOT NULL DEFAULT '{}';

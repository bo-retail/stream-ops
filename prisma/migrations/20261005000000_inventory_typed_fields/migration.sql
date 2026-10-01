-- Inventory: the details the team typed in the app, which a later master
-- never overwrites. Purely additive; every existing model starts with none.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "typedFields" TEXT[] DEFAULT ARRAY[]::TEXT[];

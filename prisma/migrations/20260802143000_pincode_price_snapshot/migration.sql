-- AlterTable
ALTER TABLE "ProductPincode" ADD COLUMN IF NOT EXISTS "lastPrice" DECIMAL(12,2);
ALTER TABLE "ProductPincode" ADD COLUMN IF NOT EXISTS "lastOldPrice" DECIMAL(12,2);

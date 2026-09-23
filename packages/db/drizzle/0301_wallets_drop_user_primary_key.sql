-- Custom SQL migration file, put your code below! --
-- X-5 / WAL-1: credit_balances became `wallets` in 0298 (a pure rename, so every
-- balance row is untouched). A wallet may be owned by an org, so `userId` can no longer
-- be the primary key; 0300 adds `id` as the new one. drizzle-kit cannot name a primary
-- key it did not create and emits this DROP only as a commented-out TODO, so it lives in
-- its own custom migration. It drops the key constraint only: no row, no value, and the
-- NOT NULL on "userId" (dropped in 0300) are touched here. Re-runnable.
ALTER TABLE "wallets" DROP CONSTRAINT IF EXISTS "credit_balances_pkey";

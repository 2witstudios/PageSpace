-- Custom SQL migration file, put your code below! --
-- X-5 / WAL-5, deploy safety. RUNS BEFORE 0301 and 0302: the migrator applies migrations in
-- meta/_journal.json order (drizzle's readMigrationFiles walks `entries` in order and keys each
-- one by its file hash), and this file's journal entry sits directly after 0300's. The file is
-- named 0300_1_* so the folder listing reads in run order; its `idx` is the one drizzle-kit
-- minted. Nothing in 0301 or 0302 is edited — those already shipped, and the runner is
-- hash-keyed, so editing them would re-run a changed file on every database.
--
-- Why this exists: the runner commits each migration in its own transaction, so between 0298 and
-- 0302 OLD application pods keep serving and keep writing credit_ledger claims and credit_holds
-- with no walletId (old code does not know the column). A row committed DURING 0301's UPDATE is
-- outside that statement's snapshot, so 0301's own guard raises; a row committed BETWEEN 0301 and
-- 0302 makes 0302's SET NOT NULL fail. Either way the deploy stops with 0298-0300 committed and
-- old pods on a schema they cannot use.
--
-- This migration closes that window in ONE transaction: it locks both tables against writers,
-- backfills whatever is still unassigned, and makes walletId required. An in-flight writer
-- commits first and its row is backfilled here; a later writer waits for this transaction and
-- then meets the NOT NULL, so its insert is refused and the caller's own retry path bills it
-- (the credit-backfill sweeps). Readers are never blocked: SHARE ROW EXCLUSIVE conflicts with
-- INSERT/UPDATE/DELETE, not with SELECT.
--
-- 0301 and 0302 then find nothing to do: their UPDATEs match no rows, 0301's guard passes, and
-- 0302's SET NOT NULL is a no-op. Every statement here is idempotent, so a database that already
-- ran 0301/0302 (CI, a developer's database) applies this one as a no-op too.
LOCK TABLE "credit_ledger", "credit_holds" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- A user with ledger or hold rows but no balance row (billing-off ceiling holds) gets a
-- ZERO personal root wallet, so their rows have a wallet to point at. It adds no money.
INSERT INTO "wallets" ("ownerType", "userId")
SELECT 'user', src."userId"
FROM (
  SELECT "userId" FROM "credit_ledger" WHERE "walletId" IS NULL
  UNION
  SELECT "userId" FROM "credit_holds" WHERE "walletId" IS NULL
) AS src
WHERE NOT EXISTS (
  SELECT 1 FROM "wallets" w
  WHERE w."userId" = src."userId"
    AND w."ownerType" = 'user'
    AND w."subjectType" IS NULL
    AND w."parentWalletId" IS NULL
)
ON CONFLICT ("userId") WHERE "ownerType" = 'user' AND "subjectType" IS NULL AND "parentWalletId" IS NULL DO NOTHING;
--> statement-breakpoint
UPDATE "credit_ledger" AS l
SET "walletId" = w."id"
FROM "wallets" AS w
WHERE l."walletId" IS NULL
  AND w."userId" = l."userId"
  AND w."ownerType" = 'user'
  AND w."subjectType" IS NULL
  AND w."parentWalletId" IS NULL;
--> statement-breakpoint
UPDATE "credit_holds" AS h
SET "walletId" = w."id"
FROM "wallets" AS w
WHERE h."walletId" IS NULL
  AND w."userId" = h."userId"
  AND w."ownerType" = 'user'
  AND w."subjectType" IS NULL
  AND w."parentWalletId" IS NULL;
--> statement-breakpoint
-- Refuse to continue while any row is still unassigned, naming how many.
DO $$
DECLARE
  ledger_missing bigint;
  holds_missing bigint;
BEGIN
  SELECT count(*) INTO ledger_missing FROM "credit_ledger" WHERE "walletId" IS NULL;
  SELECT count(*) INTO holds_missing FROM "credit_holds" WHERE "walletId" IS NULL;
  IF ledger_missing > 0 OR holds_missing > 0 THEN
    RAISE EXCEPTION 'wallets backfill incomplete: % credit_ledger and % credit_holds row(s) have no walletId',
      ledger_missing, holds_missing;
  END IF;
END $$;
--> statement-breakpoint
-- Required in the SAME transaction, still under the lock, so no NULL can land between the
-- backfill and the constraint.
ALTER TABLE "credit_ledger" ALTER COLUMN "walletId" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "credit_holds" ALTER COLUMN "walletId" SET NOT NULL;

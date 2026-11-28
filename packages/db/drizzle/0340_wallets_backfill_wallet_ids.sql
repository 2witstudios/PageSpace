-- Custom SQL migration file, put your code below! --
-- X-5 / WAL-5 backfill: every credit_ledger and credit_holds row gets the wallet it
-- belongs to. Every row written before wallets existed belongs to its user's PERSONAL
-- ROOT WALLET, which is the row that was their credit_balances row (renamed in place by
-- 0298, so no balance value moves here). 0302 then makes walletId NOT NULL.
--
-- A data backfill cannot be expressed by drizzle, and it must run in the SAME migrate
-- invocation as the NOT NULL that follows it (all pending migrations run in one go), so
-- it is a custom migration rather than a script. `scripts/backfill-wallets.ts` runs
-- these exact statements (read from this file) for a --dry-run rehearsal or a repair.
--
-- Idempotent: every statement only touches rows whose walletId is still NULL, and the
-- wallet insert is ON CONFLICT DO NOTHING against the one-personal-root-per-user index.
-- A second run changes nothing.
--
-- 1. A user with ledger or hold rows but no balance row (holds placed on a billing-off
--    deployment, which never had a balance) gets a zero personal root wallet, so their
--    rows have a wallet to point at. Zero cents: it adds no money.
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
-- 2. Ledger rows: the owner's personal root wallet.
UPDATE "credit_ledger" AS l
SET "walletId" = w."id"
FROM "wallets" AS w
WHERE l."walletId" IS NULL
  AND w."userId" = l."userId"
  AND w."ownerType" = 'user'
  AND w."subjectType" IS NULL
  AND w."parentWalletId" IS NULL;
--> statement-breakpoint
-- 3. Hold rows: the same.
UPDATE "credit_holds" AS h
SET "walletId" = w."id"
FROM "wallets" AS w
WHERE h."walletId" IS NULL
  AND w."userId" = h."userId"
  AND w."ownerType" = 'user'
  AND w."subjectType" IS NULL
  AND w."parentWalletId" IS NULL;
--> statement-breakpoint
-- 4. Guard: refuse to continue (and so refuse 0302's NOT NULL) while any row is still
--    unassigned, naming how many; otherwise report what the backfill covered.
DO $$
DECLARE
  ledger_missing bigint;
  holds_missing bigint;
  wallet_count bigint;
BEGIN
  SELECT count(*) INTO ledger_missing FROM "credit_ledger" WHERE "walletId" IS NULL;
  SELECT count(*) INTO holds_missing FROM "credit_holds" WHERE "walletId" IS NULL;
  IF ledger_missing > 0 OR holds_missing > 0 THEN
    RAISE EXCEPTION 'wallets backfill incomplete: % credit_ledger and % credit_holds row(s) have no walletId',
      ledger_missing, holds_missing;
  END IF;
  SELECT count(*) INTO wallet_count FROM "wallets";
  RAISE NOTICE 'wallets backfill complete: every credit_ledger and credit_holds row has a walletId (% wallet(s))', wallet_count;
END $$;

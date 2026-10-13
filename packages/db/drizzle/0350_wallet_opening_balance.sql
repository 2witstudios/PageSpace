-- Custom SQL migration file, put your code below! --
-- WAL-5 cutover: one opening_balance ledger row per wallet equal to its net (monthly + top-up
-- - debt) minus what its existing rows already account for, so balance-drift reconciliation is
-- exact from here on. The per-entry-type rule mirrors ledgerMovementCents
-- (packages/lib/src/billing/wallet-ledger-core.ts) as of this cutover. Idempotent: the stripeRef
-- 'opening-balance:<walletId>' is unique, so a re-run writes nothing for a wallet already opened.
INSERT INTO "credit_ledger" ("id", "userId", "walletId", "entryType", "bucket", "amountCents", "appliedCents", "stripeRef", "consumeStatus")
SELECT
  gen_random_uuid()::text,
  COALESCE(w."userId", o."ownerId"),
  w."id",
  'opening_balance',
  'monthly',
  delta.cents,
  delta.cents,
  'opening-balance:' || w."id",
  'applied'
FROM "wallets" w
LEFT JOIN "organizations" o ON o."id" = w."orgId"
CROSS JOIN LATERAL (
  SELECT (w."monthlyRemainingCents" + w."topupRemainingCents" - GREATEST(w."debtCents", 0)) - COALESCE(SUM(
    CASE
      WHEN l."entryType" IN ('seat_overshoot_month', 'seat_overshoot_day') THEN 0
      WHEN l."entryType" IN ('monthly_grant', 'topup_purchase', 'missed_grant', 'debt_forgiven', 'allocation_reset', 'opening_balance') THEN l."amountCents"
      WHEN l."entryType" IN ('usage', 'donation', 'wallet_topup', 'allocation_draw', 'leg_refund') THEN COALESCE(l."appliedCents", 0)
      ELSE COALESCE(l."appliedCents", l."amountCents")
    END
  ), 0)::integer AS cents
  FROM "credit_ledger" l
  WHERE l."walletId" = w."id"
) delta
WHERE delta.cents <> 0
  AND COALESCE(w."userId", o."ownerId") IS NOT NULL
ON CONFLICT ("stripeRef") WHERE "stripeRef" IS NOT NULL DO NOTHING;

-- Enforce the credit_balances invariants at the DATABASE — the last line of defense
-- on a money table. The schema has long DECLARED these checks, but the drizzle-kit
-- version in use does not emit check() constraints into generated migrations, so they
-- were never actually applied (only credit_balances_pending_millicents_range, added by
-- hand-authored migration 0146, made it in). This custom migration makes the schema's
-- claims true: every bucket is non-negative, the new debt counter is non-negative
-- (the net goes negative via subtraction, never the column), and the billing window is
-- ordered. Each ADD CONSTRAINT is wrapped so re-running (or an env where one already
-- exists) is a no-op instead of an error.

DO $$ BEGIN
 ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_monthly_remaining_nonneg" CHECK ("monthlyRemainingCents" >= 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_monthly_allowance_nonneg" CHECK ("monthlyAllowanceCents" >= 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_topup_remaining_nonneg" CHECK ("topupRemainingCents" >= 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_debt_cents_nonneg" CHECK ("debtCents" >= 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_period_order" CHECK ("monthlyPeriodStart" IS NULL OR "monthlyPeriodEnd" IS NULL OR "monthlyPeriodStart" <= "monthlyPeriodEnd");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

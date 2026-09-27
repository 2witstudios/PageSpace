ALTER TABLE "credit_balances" RENAME TO "wallets";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_monthly_remaining_nonneg";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_monthly_allowance_nonneg";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_topup_remaining_nonneg";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_debt_cents_nonneg";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_pending_millicents_range";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_period_order";--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "credit_balances_userId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "credit_balances_monthly_remaining_nonneg" CHECK ("wallets"."monthlyRemainingCents" >= 0);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "credit_balances_monthly_allowance_nonneg" CHECK ("wallets"."monthlyAllowanceCents" >= 0);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "credit_balances_topup_remaining_nonneg" CHECK ("wallets"."topupRemainingCents" >= 0);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "credit_balances_debt_cents_nonneg" CHECK ("wallets"."debtCents" >= 0);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "credit_balances_pending_millicents_range" CHECK ("wallets"."pendingMillicents" >= 0 AND "wallets"."pendingMillicents" < 1000);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "credit_balances_period_order" CHECK ("wallets"."monthlyPeriodStart" IS NULL OR "wallets"."monthlyPeriodEnd" IS NULL OR "wallets"."monthlyPeriodStart" <= "wallets"."monthlyPeriodEnd");
DROP INDEX IF EXISTS "credit_ledger_usage_log_unique";--> statement-breakpoint
ALTER TABLE "credit_balances" ADD COLUMN "pendingMillicents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "appliedCents" integer;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "chargeMillicents" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_usage_log_unique" ON "credit_ledger" USING btree ("aiUsageLogId") WHERE "credit_ledger"."aiUsageLogId" IS NOT NULL AND "credit_ledger"."entryType" = 'usage';
ALTER TABLE "ai_usage_logs" ADD COLUMN "reconcile_status" text;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "reconcile_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "reconciled_at" timestamp;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "reconcileGenerationKey" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_reconcile" ON "ai_usage_logs" USING btree ("reconcile_status","timestamp") WHERE reconcile_status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_reconcile_key_unique" ON "credit_ledger" USING btree ("reconcileGenerationKey") WHERE "credit_ledger"."reconcileGenerationKey" IS NOT NULL;
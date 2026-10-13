ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_userId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "credit_ledger" ALTER COLUMN "userId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "unattributed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "fallbackFromWalletId" text;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_fallbackFromWalletId_wallets_id_fk" FOREIGN KEY ("fallbackFromWalletId") REFERENCES "public"."wallets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_usage_unattributed" ON "ai_usage_logs" USING btree ("unattributed_at") WHERE unattributed_at IS NOT NULL;
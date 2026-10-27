ALTER TABLE "wallets" DROP CONSTRAINT "wallets_subject_type_valid";--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "automation_ref" text;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "automationRef" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "guestSpendEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_guest_spend_subject_wallet" CHECK (NOT "wallets"."guestSpendEnabled" OR "wallets"."subjectType" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_subject_type_valid" CHECK ("wallets"."subjectType" IS NULL OR "wallets"."subjectType" = 'drive');
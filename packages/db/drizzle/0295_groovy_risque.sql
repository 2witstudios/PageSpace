ALTER TABLE "users" ADD COLUMN "subscriptionGrandfathered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "paidCents" integer;
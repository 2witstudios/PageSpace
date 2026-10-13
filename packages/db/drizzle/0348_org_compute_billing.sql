CREATE TABLE "billing_epochs" (
	"key" text PRIMARY KEY NOT NULL,
	"startedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_holds" ADD COLUMN "spendKind" text DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "spendKind" text DEFAULT 'ai' NOT NULL;
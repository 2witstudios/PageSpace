CREATE TABLE IF NOT EXISTS "contact_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_submissions_email_idx" ON "contact_submissions" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_submissions_created_at_idx" ON "contact_submissions" USING btree ("createdAt");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "storageQuotaBytes";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "storageTier";
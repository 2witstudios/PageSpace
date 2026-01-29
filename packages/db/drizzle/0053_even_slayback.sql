ALTER TABLE "users" ADD COLUMN "suspendedAt" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspendedReason" text;
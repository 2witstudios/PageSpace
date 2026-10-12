ALTER TABLE "device_tokens" ADD COLUMN "authenticatedAt" timestamp;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD COLUMN "authenticationAssurance" text;
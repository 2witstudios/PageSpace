ALTER TABLE "sessions" ADD COLUMN "authenticated_at" timestamp;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "authentication_assurance" text;
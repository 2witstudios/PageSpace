ALTER TABLE "refresh_tokens" ADD COLUMN "revokedAt" timestamp;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "revokedReason" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_revoked_idx" ON "refresh_tokens" USING btree ("tokenHash","revokedAt");
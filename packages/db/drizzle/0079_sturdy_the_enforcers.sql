ALTER TABLE "ai_usage_logs" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_expires_at" ON "ai_usage_logs" USING btree ("expires_at");
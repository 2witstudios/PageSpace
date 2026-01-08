ALTER TABLE "mcp_tokens" ADD COLUMN "tokenHash" text;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "tokenPrefix" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "tokenHash" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "tokenPrefix" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "previousLogHash" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "logHash" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "chainSeed" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_tokens_token_hash_partial_idx" ON "mcp_tokens" USING btree ("tokenHash") WHERE "mcp_tokens"."tokenHash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_token_hash_partial_idx" ON "refresh_tokens" USING btree ("tokenHash") WHERE "refresh_tokens"."tokenHash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_logs_log_hash" ON "activity_logs" USING btree ("logHash") WHERE "activity_logs"."logHash" IS NOT NULL;
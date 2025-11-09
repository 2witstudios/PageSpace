ALTER TABLE "ai_usage_logs" ADD COLUMN "context_messages" jsonb;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "context_size" integer;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "system_prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "tool_definition_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "conversation_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "message_count" integer;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "was_truncated" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "truncation_strategy" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_context" ON "ai_usage_logs" USING btree ("conversation_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_context_size" ON "ai_usage_logs" USING btree ("context_size");
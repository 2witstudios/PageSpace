ALTER TABLE "users" ADD COLUMN "selectedGlobalAgentId" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "agentPageId" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_agent_page_id_idx" ON "conversations" USING btree ("agentPageId");
ALTER TABLE "direct_messages" ADD COLUMN "isActive" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD COLUMN "deletedAt" timestamp;--> statement-breakpoint
UPDATE "direct_messages" SET "deletedAt" = NOW() WHERE "isActive" = false AND "deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_messages_conversation_active_created_idx" ON "direct_messages" USING btree ("conversationId","isActive","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_messages_inactive_deleted_at_idx" ON "direct_messages" USING btree ("isActive","deletedAt");

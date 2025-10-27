-- Step 1: Add conversationId column as nullable first
ALTER TABLE "chat_messages" ADD COLUMN "conversationId" text;--> statement-breakpoint

-- Step 2: Backfill existing messages - group all existing messages per pageId into a single conversation
-- This creates a "Default Conversation" for each agent containing all their historical messages
UPDATE "chat_messages"
SET "conversationId" = CONCAT('conv_default_', "pageId")
WHERE "conversationId" IS NULL;--> statement-breakpoint

-- Step 3: Now make the column NOT NULL since all rows have values
ALTER TABLE "chat_messages" ALTER COLUMN "conversationId" SET NOT NULL;--> statement-breakpoint

-- Step 4: Create indexes for efficient conversation queries
CREATE INDEX IF NOT EXISTS "chat_messages_conversation_id_idx" ON "chat_messages" USING btree ("conversationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_page_id_conversation_id_idx" ON "chat_messages" USING btree ("pageId","conversationId");
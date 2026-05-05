ALTER TABLE "channel_messages" ADD COLUMN "quotedMessageId" text;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD COLUMN "quotedMessageId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_quotedMessageId_channel_messages_id_fk" FOREIGN KEY ("quotedMessageId") REFERENCES "public"."channel_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_quotedMessageId_direct_messages_id_fk" FOREIGN KEY ("quotedMessageId") REFERENCES "public"."direct_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_quoted_id_idx" ON "channel_messages" USING btree ("quotedMessageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_messages_quoted_id_idx" ON "direct_messages" USING btree ("quotedMessageId");
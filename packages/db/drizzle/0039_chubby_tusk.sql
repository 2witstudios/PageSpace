ALTER TABLE "chat_messages" ADD COLUMN "sourceAgentId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sourceAgentId_pages_id_fk" FOREIGN KEY ("sourceAgentId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

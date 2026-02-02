ALTER TABLE "channel_messages" ADD COLUMN "fileId" text;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "attachmentMeta" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_fileId_files_id_fk" FOREIGN KEY ("fileId") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_file_id_idx" ON "channel_messages" USING btree ("fileId");
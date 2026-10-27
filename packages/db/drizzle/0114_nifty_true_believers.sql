CREATE TABLE IF NOT EXISTS "file_conversations" (
	"fileId" text NOT NULL,
	"conversationId" text NOT NULL,
	"linkedBy" text,
	"linkedAt" timestamp DEFAULT now() NOT NULL,
	"linkSource" text,
	CONSTRAINT "file_conversations_fileId_conversationId_pk" PRIMARY KEY("fileId","conversationId")
);
--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "driveId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD COLUMN "fileId" text;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD COLUMN "attachmentMeta" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_conversations" ADD CONSTRAINT "file_conversations_fileId_files_id_fk" FOREIGN KEY ("fileId") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_conversations" ADD CONSTRAINT "file_conversations_conversationId_dm_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."dm_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_conversations" ADD CONSTRAINT "file_conversations_linkedBy_users_id_fk" FOREIGN KEY ("linkedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_conversations_file_id_idx" ON "file_conversations" USING btree ("fileId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_conversations_conversation_id_idx" ON "file_conversations" USING btree ("conversationId");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_fileId_files_id_fk" FOREIGN KEY ("fileId") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_messages_file_id_idx" ON "direct_messages" USING btree ("fileId");
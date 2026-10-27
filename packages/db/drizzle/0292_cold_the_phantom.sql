CREATE TABLE "channel_message_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"messageId" text NOT NULL,
	"fileId" text,
	"attachmentMeta" jsonb,
	"position" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "channel_message_attachments_position_range" CHECK ("channel_message_attachments"."position" >= 0 AND "channel_message_attachments"."position" < 10)
);
--> statement-breakpoint
CREATE TABLE "direct_message_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"messageId" text NOT NULL,
	"fileId" text,
	"attachmentMeta" jsonb,
	"position" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "direct_message_attachments_position_range" CHECK ("direct_message_attachments"."position" >= 0 AND "direct_message_attachments"."position" < 10)
);
--> statement-breakpoint
ALTER TABLE "channel_message_attachments" ADD CONSTRAINT "channel_message_attachments_messageId_channel_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."channel_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_message_attachments" ADD CONSTRAINT "channel_message_attachments_fileId_files_id_fk" FOREIGN KEY ("fileId") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_message_attachments" ADD CONSTRAINT "direct_message_attachments_messageId_direct_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."direct_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_message_attachments" ADD CONSTRAINT "direct_message_attachments_fileId_files_id_fk" FOREIGN KEY ("fileId") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_message_attachments_message_position_idx" ON "channel_message_attachments" USING btree ("messageId","position");--> statement-breakpoint
CREATE INDEX "channel_message_attachments_file_id_idx" ON "channel_message_attachments" USING btree ("fileId");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_message_attachments_message_position_idx" ON "direct_message_attachments" USING btree ("messageId","position");--> statement-breakpoint
CREATE INDEX "direct_message_attachments_file_id_idx" ON "direct_message_attachments" USING btree ("fileId");
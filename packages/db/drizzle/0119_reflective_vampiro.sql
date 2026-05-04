CREATE TABLE IF NOT EXISTS "channel_thread_followers" (
	"rootMessageId" text NOT NULL,
	"userId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "channel_thread_followers_rootMessageId_userId_pk" PRIMARY KEY("rootMessageId","userId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_message_reactions" (
	"id" text PRIMARY KEY NOT NULL,
	"messageId" text NOT NULL,
	"userId" text NOT NULL,
	"emoji" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_thread_followers" (
	"rootMessageId" text NOT NULL,
	"userId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dm_thread_followers_rootMessageId_userId_pk" PRIMARY KEY("rootMessageId","userId")
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "parentId" text;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "replyCount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "lastReplyAt" timestamp;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "mirroredFromId" text;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD COLUMN "parentId" text;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD COLUMN "replyCount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD COLUMN "lastReplyAt" timestamp;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD COLUMN "mirroredFromId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_thread_followers" ADD CONSTRAINT "channel_thread_followers_rootMessageId_channel_messages_id_fk" FOREIGN KEY ("rootMessageId") REFERENCES "public"."channel_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_thread_followers" ADD CONSTRAINT "channel_thread_followers_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_message_reactions" ADD CONSTRAINT "dm_message_reactions_messageId_direct_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."direct_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_message_reactions" ADD CONSTRAINT "dm_message_reactions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_thread_followers" ADD CONSTRAINT "dm_thread_followers_rootMessageId_direct_messages_id_fk" FOREIGN KEY ("rootMessageId") REFERENCES "public"."direct_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_thread_followers" ADD CONSTRAINT "dm_thread_followers_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_thread_followers_user_id_idx" ON "channel_thread_followers" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dm_unique_reaction_idx" ON "dm_message_reactions" USING btree ("messageId","userId","emoji");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_reaction_message_idx" ON "dm_message_reactions" USING btree ("messageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_thread_followers_user_id_idx" ON "dm_thread_followers" USING btree ("userId");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_parentId_channel_messages_id_fk" FOREIGN KEY ("parentId") REFERENCES "public"."channel_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_mirroredFromId_channel_messages_id_fk" FOREIGN KEY ("mirroredFromId") REFERENCES "public"."channel_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_parentId_direct_messages_id_fk" FOREIGN KEY ("parentId") REFERENCES "public"."direct_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_mirroredFromId_direct_messages_id_fk" FOREIGN KEY ("mirroredFromId") REFERENCES "public"."direct_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_parent_created_idx" ON "channel_messages" USING btree ("parentId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_messages_parent_created_idx" ON "direct_messages" USING btree ("parentId","createdAt");
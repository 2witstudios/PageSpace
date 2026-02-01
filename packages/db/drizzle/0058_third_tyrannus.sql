CREATE TABLE IF NOT EXISTS "channel_message_reactions" (
	"id" text PRIMARY KEY NOT NULL,
	"messageId" text NOT NULL,
	"userId" text NOT NULL,
	"emoji" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_message_reactions" ADD CONSTRAINT "channel_message_reactions_messageId_channel_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."channel_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_message_reactions" ADD CONSTRAINT "channel_message_reactions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "unique_reaction_idx" ON "channel_message_reactions" USING btree ("messageId","userId","emoji");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reaction_message_idx" ON "channel_message_reactions" USING btree ("messageId");
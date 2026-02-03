CREATE TABLE IF NOT EXISTS "channel_read_status" (
	"userId" text NOT NULL,
	"channelId" text NOT NULL,
	"lastReadAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "channel_read_status_userId_channelId_pk" PRIMARY KEY("userId","channelId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_read_status" ADD CONSTRAINT "channel_read_status_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_read_status" ADD CONSTRAINT "channel_read_status_channelId_pages_id_fk" FOREIGN KEY ("channelId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_read_status_user_id_idx" ON "channel_read_status" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_read_status_channel_id_idx" ON "channel_read_status" USING btree ("channelId");
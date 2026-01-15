ALTER TYPE "NotificationType" ADD VALUE 'MENTION';--> statement-breakpoint
ALTER TYPE "NotificationType" ADD VALUE 'TASK_ASSIGNED';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_mentions" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"sourcePageId" text NOT NULL,
	"targetUserId" text NOT NULL,
	"mentionedByUserId" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_mentions" ADD CONSTRAINT "user_mentions_sourcePageId_pages_id_fk" FOREIGN KEY ("sourcePageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_mentions" ADD CONSTRAINT "user_mentions_targetUserId_users_id_fk" FOREIGN KEY ("targetUserId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_mentions" ADD CONSTRAINT "user_mentions_mentionedByUserId_users_id_fk" FOREIGN KEY ("mentionedByUserId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mentions_source_page_id_target_user_id_key" ON "user_mentions" USING btree ("sourcePageId","targetUserId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mentions_source_page_id_idx" ON "user_mentions" USING btree ("sourcePageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mentions_target_user_id_idx" ON "user_mentions" USING btree ("targetUserId");
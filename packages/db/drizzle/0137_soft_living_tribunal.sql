CREATE TABLE IF NOT EXISTS "message_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"contextKey" text NOT NULL,
	"content" text NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_items" DROP CONSTRAINT "task_items_taskListId_task_lists_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "task_items_task_list_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "task_items_task_list_status_idx";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_drafts_user_context_key" ON "message_drafts" USING btree ("userId","contextKey");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_drafts_expires_at_idx" ON "message_drafts" USING btree ("expiresAt");--> statement-breakpoint
ALTER TABLE "task_items" DROP COLUMN IF EXISTS "taskListId";--> statement-breakpoint
-- Remove ghost task_items backfilled by migration 0120 where pageId points to the
-- task list page itself (not a dedicated child page). These items are invisible in
-- the new pages.parentId membership model and would violate the upcoming UNIQUE constraint.
DELETE FROM "task_items" WHERE "pageId" IN (SELECT "pageId" FROM "task_lists" WHERE "pageId" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "task_items" ADD CONSTRAINT "task_items_pageId_unique" UNIQUE("pageId");
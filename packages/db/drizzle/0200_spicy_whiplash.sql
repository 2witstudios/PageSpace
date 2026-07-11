ALTER TABLE "terminal_sessions" RENAME TO "machine_sessions";--> statement-breakpoint
ALTER TABLE "machine_sessions" DROP CONSTRAINT "terminal_sessions_sessionKey_unique";--> statement-breakpoint
ALTER TABLE "machine_sessions" DROP CONSTRAINT "terminal_sessions_pageId_pages_id_fk";
--> statement-breakpoint
ALTER TABLE "machine_sessions" DROP CONSTRAINT "terminal_sessions_userId_users_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "terminal_sessions_page_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "terminal_sessions_last_active_at_idx";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_sessions" ADD CONSTRAINT "machine_sessions_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_sessions" ADD CONSTRAINT "machine_sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_sessions_page_id_idx" ON "machine_sessions" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_sessions_last_active_at_idx" ON "machine_sessions" USING btree ("lastActiveAt");--> statement-breakpoint
ALTER TABLE "machine_sessions" ADD CONSTRAINT "machine_sessions_sessionKey_unique" UNIQUE("sessionKey");
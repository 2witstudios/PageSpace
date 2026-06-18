CREATE TABLE IF NOT EXISTS "terminal_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"sessionKey" text NOT NULL,
	"pageId" text NOT NULL,
	"userId" text NOT NULL,
	"sandboxId" text NOT NULL,
	"lastActiveAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "terminal_sessions_sessionKey_unique" UNIQUE("sessionKey")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "terminal_sessions_session_key_idx" ON "terminal_sessions" USING btree ("sessionKey");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "terminal_sessions_page_id_idx" ON "terminal_sessions" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "terminal_sessions_last_active_at_idx" ON "terminal_sessions" USING btree ("lastActiveAt");
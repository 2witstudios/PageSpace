CREATE TABLE IF NOT EXISTS "user_page_views" (
	"userId" text NOT NULL,
	"pageId" text NOT NULL,
	"viewedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_page_views_userId_pageId_pk" PRIMARY KEY("userId","pageId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_page_views" ADD CONSTRAINT "user_page_views_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_page_views" ADD CONSTRAINT "user_page_views_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_page_views_user_id_idx" ON "user_page_views" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_page_views_page_id_idx" ON "user_page_views" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_page_views_user_page_idx" ON "user_page_views" USING btree ("userId","pageId");
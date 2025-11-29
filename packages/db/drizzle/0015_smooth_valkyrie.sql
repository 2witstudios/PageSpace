ALTER TABLE "task_items" ADD COLUMN "pageId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_items" ADD CONSTRAINT "task_items_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_items_page_id_idx" ON "task_items" USING btree ("pageId");
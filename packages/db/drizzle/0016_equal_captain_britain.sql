ALTER TABLE "task_items" DROP CONSTRAINT "task_items_pageId_pages_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_items" ADD CONSTRAINT "task_items_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

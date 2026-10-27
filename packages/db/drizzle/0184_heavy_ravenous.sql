ALTER TABLE "drives" ADD COLUMN "not_found_page_id" text;--> statement-breakpoint
ALTER TABLE "drives" ADD COLUMN "publish_favicon_url" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drives" ADD CONSTRAINT "drives_not_found_page_id_pages_id_fk" FOREIGN KEY ("not_found_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

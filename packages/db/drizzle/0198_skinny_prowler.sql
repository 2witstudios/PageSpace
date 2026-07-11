ALTER TABLE "custom_domains" ADD COLUMN "publish_landing_page_id" text;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD COLUMN "publish_not_found_page_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_publish_landing_page_id_pages_id_fk" FOREIGN KEY ("publish_landing_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_publish_not_found_page_id_pages_id_fk" FOREIGN KEY ("publish_not_found_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

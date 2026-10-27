ALTER TABLE "drives" ADD COLUMN "homePageId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drives" ADD CONSTRAINT "drives_homePageId_pages_id_fk" FOREIGN KEY ("homePageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

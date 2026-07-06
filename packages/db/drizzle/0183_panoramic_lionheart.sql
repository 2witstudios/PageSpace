ALTER TABLE "form_targets" ADD COLUMN "canvas_page_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_targets" ADD CONSTRAINT "form_targets_canvas_page_id_pages_id_fk" FOREIGN KEY ("canvas_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_targets_canvas_page_id_idx" ON "form_targets" USING btree ("canvas_page_id");
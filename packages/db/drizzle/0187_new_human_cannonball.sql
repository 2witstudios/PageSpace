ALTER TABLE "global_assistant_config" ADD COLUMN "terminal_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "global_assistant_config" ADD COLUMN "machines" jsonb;--> statement-breakpoint
ALTER TABLE "global_assistant_config" ADD COLUMN "own_machine_page_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "global_assistant_config" ADD CONSTRAINT "global_assistant_config_own_machine_page_id_pages_id_fk" FOREIGN KEY ("own_machine_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

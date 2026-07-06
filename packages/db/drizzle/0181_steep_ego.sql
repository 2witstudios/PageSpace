CREATE TABLE IF NOT EXISTS "form_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"drive_id" text NOT NULL,
	"page_id" text NOT NULL,
	"action" text DEFAULT 'sheet:append' NOT NULL,
	"fields" jsonb NOT NULL,
	"header_row" integer DEFAULT 1 NOT NULL,
	"next_row" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_submitted_at" timestamp,
	"submission_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "form_targets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_targets" ADD CONSTRAINT "form_targets_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_targets" ADD CONSTRAINT "form_targets_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_targets" ADD CONSTRAINT "form_targets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_targets_token_hash_idx" ON "form_targets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_targets_page_id_idx" ON "form_targets" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_targets_drive_id_idx" ON "form_targets" USING btree ("drive_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_targets_status_idx" ON "form_targets" USING btree ("status");
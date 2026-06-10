CREATE TABLE IF NOT EXISTS "commands" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"drive_id" text,
	"trigger" text NOT NULL,
	"description" text NOT NULL,
	"entry_page_id" text NOT NULL,
	"type" text DEFAULT 'document' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commands_user_trigger" UNIQUE("user_id","trigger"),
	CONSTRAINT "commands_drive_trigger" UNIQUE("drive_id","trigger")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commands" ADD CONSTRAINT "commands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commands" ADD CONSTRAINT "commands_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commands" ADD CONSTRAINT "commands_entry_page_id_pages_id_fk" FOREIGN KEY ("entry_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commands_user_id_idx" ON "commands" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commands_drive_id_idx" ON "commands" USING btree ("drive_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commands_entry_page_id_idx" ON "commands" USING btree ("entry_page_id");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "commands" ADD CONSTRAINT "commands_scope_chk" CHECK (
    ("user_id" IS NOT NULL AND "drive_id" IS NULL) OR ("user_id" IS NULL AND "drive_id" IS NOT NULL)
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
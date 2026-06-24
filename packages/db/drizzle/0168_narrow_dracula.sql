DO $$ BEGIN
 CREATE TYPE "public"."custom_domain_status" AS ENUM('pending', 'verified', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"drive_id" text NOT NULL,
	"hostname" text NOT NULL,
	"status" "custom_domain_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_domains_hostname_key" ON "custom_domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_domains_drive_id_idx" ON "custom_domains" USING btree ("drive_id");
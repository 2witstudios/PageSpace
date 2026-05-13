CREATE TABLE IF NOT EXISTS "drive_share_links" (
	"id" text PRIMARY KEY NOT NULL,
	"drive_id" text NOT NULL,
	"token" text NOT NULL,
	"role" "MemberRole" DEFAULT 'MEMBER' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "drive_share_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_share_links" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"token" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "page_share_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_share_links" ADD CONSTRAINT "drive_share_links_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_share_links" ADD CONSTRAINT "drive_share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_share_links" ADD CONSTRAINT "page_share_links_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_share_links" ADD CONSTRAINT "page_share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_share_links_drive_id_idx" ON "drive_share_links" USING btree ("drive_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_share_links_expires_at_idx" ON "drive_share_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_share_links_is_active_idx" ON "drive_share_links" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_share_links_page_id_idx" ON "page_share_links" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_share_links_expires_at_idx" ON "page_share_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_share_links_is_active_idx" ON "page_share_links" USING btree ("is_active");
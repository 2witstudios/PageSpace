CREATE TABLE IF NOT EXISTS "published_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"drive_id" text NOT NULL,
	"page_id" text NOT NULL,
	"path" text NOT NULL,
	"artifact_key" text NOT NULL,
	"published_by" text,
	"published_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "published_pages_page_id_key" UNIQUE("page_id"),
	CONSTRAINT "published_pages_drive_id_path_key" UNIQUE("drive_id","path")
);
--> statement-breakpoint
ALTER TABLE "drives" ADD COLUMN "publishSubdomain" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "published_pages_drive_id_idx" ON "published_pages" USING btree ("drive_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "published_pages_page_id_idx" ON "published_pages" USING btree ("page_id");--> statement-breakpoint
ALTER TABLE "drives" ADD CONSTRAINT "drives_publishSubdomain_unique" UNIQUE("publishSubdomain");
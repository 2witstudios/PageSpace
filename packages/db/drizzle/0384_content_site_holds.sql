CREATE TABLE "content_site_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"drive_id" text NOT NULL,
	"holder" text NOT NULL,
	"source" text NOT NULL,
	"case_id" text,
	"user_id" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "content_site_holds_drive_holder_key" ON "content_site_holds" USING btree ("drive_id","holder");--> statement-breakpoint
CREATE INDEX "content_site_holds_user_id_idx" ON "content_site_holds" USING btree ("user_id");
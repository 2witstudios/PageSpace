CREATE TABLE "content_site_holds" (
	"drive_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"case_id" text,
	"user_id" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "content_site_holds_user_id_idx" ON "content_site_holds" USING btree ("user_id");
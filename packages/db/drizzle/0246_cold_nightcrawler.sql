CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"drive_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"goal" text NOT NULL,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plans_page_id_key" UNIQUE("page_id")
);
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plans_drive_id_idx" ON "plans" USING btree ("drive_id");--> statement-breakpoint
CREATE INDEX "plans_status_idx" ON "plans" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plans_page_id_idx" ON "plans" USING btree ("page_id");
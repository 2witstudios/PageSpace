CREATE TABLE "content_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"source" text NOT NULL,
	"reporter_user_id" text,
	"contact_email" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "content_reports_case_id_created_at_idx" ON "content_reports" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_cases_reported_target_key" ON "content_cases" USING btree ("target_type","target_id") WHERE "content_cases"."status" = 'reported';
CREATE TABLE "content_blocks" (
	"content_hash" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"source" text NOT NULL,
	"case_id" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"content_hash" text,
	"status" text DEFAULT 'open' NOT NULL,
	"category" text,
	"reporter_user_id" text,
	"reporter_contact" text,
	"reason" text,
	"snapshot" jsonb,
	"steps" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_scans" (
	"content_hash" text PRIMARY KEY NOT NULL,
	"verdict" text NOT NULL,
	"provider" text NOT NULL,
	"provider_version" text,
	"scores" jsonb,
	"scanned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "content_blocks_case_id_idx" ON "content_blocks" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "content_cases_target_idx" ON "content_cases" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "content_cases_content_hash_idx" ON "content_cases" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "content_cases_status_created_at_idx" ON "content_cases" USING btree ("status","created_at");
CREATE TABLE "content_scan_backfill" (
	"id" text PRIMARY KEY NOT NULL,
	"phase" text NOT NULL,
	"start_after" text,
	"pass" integer DEFAULT 1 NOT NULL,
	"counts" jsonb NOT NULL,
	"last_pass_counts" jsonb,
	"pass_started_at" timestamp DEFAULT now() NOT NULL,
	"last_completed_at" timestamp,
	"lease_until" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

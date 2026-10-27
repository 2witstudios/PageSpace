CREATE TABLE IF NOT EXISTS "error_resolutions" (
	"error_id" text PRIMARY KEY NOT NULL,
	"resolved" boolean DEFAULT true NOT NULL,
	"resolved_at" timestamp DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolution" text
);

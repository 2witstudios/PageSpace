CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_buckets_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_buckets_expires_at_idx" ON "rate_limit_buckets" USING btree ("expires_at");
CREATE TABLE IF NOT EXISTS "revoked_service_tokens" (
	"jti" text PRIMARY KEY NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revoked_service_tokens_expires_at_idx" ON "revoked_service_tokens" USING btree ("expires_at");
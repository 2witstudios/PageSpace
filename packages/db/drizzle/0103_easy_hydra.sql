CREATE TABLE IF NOT EXISTS "auth_handoff_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_handoff_tokens_expires_at_idx" ON "auth_handoff_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_handoff_tokens_kind_expires_at_idx" ON "auth_handoff_tokens" USING btree ("kind","expires_at");
CREATE TABLE IF NOT EXISTS "socket_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"tokenHash" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "socket_tokens_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "socket_tokens" ADD CONSTRAINT "socket_tokens_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "socket_tokens_user_id_idx" ON "socket_tokens" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "socket_tokens_token_hash_idx" ON "socket_tokens" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "socket_tokens_expires_at_idx" ON "socket_tokens" USING btree ("expiresAt");
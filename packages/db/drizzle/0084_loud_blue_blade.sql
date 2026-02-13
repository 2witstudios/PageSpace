CREATE TABLE IF NOT EXISTS "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"device_type" text,
	"transports" text[],
	"backed_up" boolean DEFAULT false,
	"name" text,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkeys_user_id_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkeys_credential_id_idx" ON "passkeys" USING btree ("credential_id");--> statement-breakpoint
-- System user for anonymous passkey authentication challenges (conditional UI)
-- This user is used as a FK target when storing auth challenges without a specific user
INSERT INTO "users" ("id", "name", "email", "provider", "role", "tokenVersion", "createdAt", "updatedAt")
VALUES ('system-passkey-auth', 'System', 'system@pagespace.local', 'email', 'user', 0, now(), now())
ON CONFLICT (id) DO NOTHING;
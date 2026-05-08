CREATE TABLE IF NOT EXISTS "pending_page_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"invited_by" text NOT NULL,
	"page_id" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pending_page_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_connection_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"invited_by" text NOT NULL,
	"request_message" text,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pending_connection_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_page_invites" ADD CONSTRAINT "pending_page_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_page_invites" ADD CONSTRAINT "pending_page_invites_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_connection_invites" ADD CONSTRAINT "pending_connection_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_page_invites_page_id_idx" ON "pending_page_invites" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_page_invites_expires_at_idx" ON "pending_page_invites" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pending_page_invites_active_page_email_idx" ON "pending_page_invites" USING btree ("page_id","email") WHERE "pending_page_invites"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_connection_invites_invited_by_idx" ON "pending_connection_invites" USING btree ("invited_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_connection_invites_expires_at_idx" ON "pending_connection_invites" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pending_connection_invites_active_inviter_email_idx" ON "pending_connection_invites" USING btree ("invited_by","email") WHERE "pending_connection_invites"."consumed_at" IS NULL;
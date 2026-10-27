CREATE TABLE IF NOT EXISTS "pending_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"drive_id" text NOT NULL,
	"role" "MemberRole" NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pending_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_invites" ADD CONSTRAINT "pending_invites_drive_id_drives_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_invites" ADD CONSTRAINT "pending_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_invites_drive_id_idx" ON "pending_invites" USING btree ("drive_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_invites_expires_at_idx" ON "pending_invites" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pending_invites_active_drive_email_idx" ON "pending_invites" USING btree ("drive_id","email") WHERE "pending_invites"."consumed_at" IS NULL;
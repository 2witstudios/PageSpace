CREATE TABLE IF NOT EXISTS "pending_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"tokenHash" text NOT NULL,
	"email" text NOT NULL,
	"driveId" text NOT NULL,
	"role" "MemberRole" DEFAULT 'MEMBER' NOT NULL,
	"invitedBy" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"consumedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pending_invites_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_invites" ADD CONSTRAINT "pending_invites_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_invites" ADD CONSTRAINT "pending_invites_invitedBy_users_id_fk" FOREIGN KEY ("invitedBy") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_invites_drive_id_idx" ON "pending_invites" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_invites_email_idx" ON "pending_invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_invites_expires_at_idx" ON "pending_invites" USING btree ("expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pending_invites_drive_email_active_unique" ON "pending_invites" USING btree ("driveId","email") WHERE "pending_invites"."consumedAt" IS NULL;
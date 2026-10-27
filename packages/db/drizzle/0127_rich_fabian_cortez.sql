CREATE TABLE IF NOT EXISTS "drive_agent_members" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"agentPageId" text NOT NULL,
	"role" "MemberRole" DEFAULT 'MEMBER' NOT NULL,
	"customRoleId" text,
	"addedBy" text,
	"addedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "drive_agent_members_drive_agent_key" UNIQUE("driveId","agentPageId")
);
--> statement-breakpoint
ALTER TABLE "pending_invites" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_page_invites" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_agent_members" ADD CONSTRAINT "drive_agent_members_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_agent_members" ADD CONSTRAINT "drive_agent_members_agentPageId_pages_id_fk" FOREIGN KEY ("agentPageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_agent_members" ADD CONSTRAINT "drive_agent_members_customRoleId_drive_roles_id_fk" FOREIGN KEY ("customRoleId") REFERENCES "public"."drive_roles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_agent_members" ADD CONSTRAINT "drive_agent_members_addedBy_users_id_fk" FOREIGN KEY ("addedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_agent_members_drive_id_idx" ON "drive_agent_members" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_agent_members_agent_page_id_idx" ON "drive_agent_members" USING btree ("agentPageId");--> statement-breakpoint
INSERT INTO "drive_agent_members" ("id", "driveId", "agentPageId", "role", "addedAt")
SELECT
  md5(random()::text || p.id),
  p."driveId",
  p.id,
  'ADMIN',
  now()
FROM pages p
WHERE p.type = 'AI_CHAT'
ON CONFLICT DO NOTHING;
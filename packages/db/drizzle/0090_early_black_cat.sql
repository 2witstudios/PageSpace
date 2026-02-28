DO $$ BEGIN
 CREATE TYPE "public"."OrgMemberRole" AS ENUM('OWNER', 'ADMIN', 'MEMBER');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"email" text NOT NULL,
	"role" "OrgMemberRole" DEFAULT 'MEMBER' NOT NULL,
	"token" text NOT NULL,
	"invitedBy" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"acceptedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_invitations_token_unique" UNIQUE("token"),
	CONSTRAINT "org_invitations_org_email_key" UNIQUE("orgId","email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_members" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"userId" text NOT NULL,
	"role" "OrgMemberRole" DEFAULT 'MEMBER' NOT NULL,
	"invitedBy" text,
	"joinedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_user_key" UNIQUE("orgId","userId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"ownerId" text NOT NULL,
	"description" text,
	"avatarUrl" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "drives" ADD COLUMN "orgId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invitedBy_users_id_fk" FOREIGN KEY ("invitedBy") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_members" ADD CONSTRAINT "org_members_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_members" ADD CONSTRAINT "org_members_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_members" ADD CONSTRAINT "org_members_invitedBy_users_id_fk" FOREIGN KEY ("invitedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organizations" ADD CONSTRAINT "organizations_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_invitations_org_id_idx" ON "org_invitations" USING btree ("orgId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_invitations_email_idx" ON "org_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_invitations_token_idx" ON "org_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_members_org_id_idx" ON "org_members" USING btree ("orgId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_members_user_id_idx" ON "org_members" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_members_role_idx" ON "org_members" USING btree ("role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_owner_id_idx" ON "organizations" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drives" ADD CONSTRAINT "drives_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drives_org_id_idx" ON "drives" USING btree ("orgId");
CREATE TYPE "public"."OrgDriveVisibility" AS ENUM('OPEN', 'RESTRICTED', 'PRIVATE');--> statement-breakpoint
CREATE TYPE "public"."DriveMemberSource" AS ENUM('invite', 'org');--> statement-breakpoint
CREATE TYPE "public"."OrgRole" AS ENUM('OWNER', 'ADMIN', 'MEMBER');--> statement-breakpoint
CREATE TABLE "org_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"email" text NOT NULL,
	"role" "OrgRole" DEFAULT 'MEMBER' NOT NULL,
	"tokenHash" text NOT NULL,
	"invitedBy" text,
	"expiresAt" timestamp NOT NULL,
	"acceptedAt" timestamp,
	"createdAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	CONSTRAINT "org_invitations_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"userId" text NOT NULL,
	"role" "OrgRole" DEFAULT 'MEMBER' NOT NULL,
	"invitedBy" text,
	"joinedAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	CONSTRAINT "org_members_org_user_key" UNIQUE("orgId","userId")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"avatarUrl" text,
	"ownerId" text NOT NULL,
	"policies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stripeCustomerId" text,
	"stripeSubscriptionId" text,
	"createdAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	"updatedAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_stripeCustomerId_unique" UNIQUE("stripeCustomerId")
);
--> statement-breakpoint
ALTER TABLE "drives" ADD COLUMN "orgId" text;--> statement-breakpoint
ALTER TABLE "drives" ADD COLUMN "orgVisibility" "OrgDriveVisibility" DEFAULT 'OPEN' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_members" ADD COLUMN "source" "DriveMemberSource" DEFAULT 'invite' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invitedBy_users_id_fk" FOREIGN KEY ("invitedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_invitedBy_users_id_fk" FOREIGN KEY ("invitedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_invitations_email_idx" ON "org_invitations" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "org_invitations_open_org_email_key" ON "org_invitations" USING btree ("orgId",lower("email")) WHERE "org_invitations"."acceptedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_one_owner_key" ON "org_members" USING btree ("orgId") WHERE "org_members"."role" = 'OWNER';--> statement-breakpoint
CREATE INDEX "org_members_user_id_idx" ON "org_members" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "organizations_owner_id_idx" ON "organizations" USING btree ("ownerId");--> statement-breakpoint
ALTER TABLE "drives" ADD CONSTRAINT "drives_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drives_org_slug_unique" ON "drives" USING btree ("orgId","slug") WHERE "drives"."orgId" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "drives" ADD CONSTRAINT "drives_home_never_org_check" CHECK ("drives"."kind" <> 'HOME' OR "drives"."orgId" IS NULL);
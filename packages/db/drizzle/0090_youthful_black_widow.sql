DO $$ BEGIN
 CREATE TYPE "public"."OrgRole" AS ENUM('OWNER', 'ADMIN', 'MEMBER');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_drives" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"driveId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_drives_org_drive_key" UNIQUE("orgId","driveId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_members" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"userId" text NOT NULL,
	"role" "OrgRole" DEFAULT 'MEMBER' NOT NULL,
	"invitedBy" text,
	"invitedAt" timestamp DEFAULT now() NOT NULL,
	"acceptedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_user_key" UNIQUE("orgId","userId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"orgId" text NOT NULL,
	"stripeSubscriptionId" text NOT NULL,
	"stripePriceId" text NOT NULL,
	"status" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"currentPeriodStart" timestamp NOT NULL,
	"currentPeriodEnd" timestamp NOT NULL,
	"cancelAtPeriodEnd" boolean DEFAULT false NOT NULL,
	"gracePeriodEnd" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_subscriptions_stripeSubscriptionId_unique" UNIQUE("stripeSubscriptionId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"ownerId" text NOT NULL,
	"allowedAIProviders" jsonb,
	"maxStorageBytes" real,
	"maxAITokensPerDay" integer,
	"requireMFA" boolean DEFAULT false NOT NULL,
	"allowExternalSharing" boolean DEFAULT true NOT NULL,
	"allowedDomains" jsonb,
	"stripeCustomerId" text,
	"billingTier" text DEFAULT 'free' NOT NULL,
	"billingEmail" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_stripeCustomerId_unique" UNIQUE("stripeCustomerId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_drives" ADD CONSTRAINT "org_drives_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_drives" ADD CONSTRAINT "org_drives_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
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
 ALTER TABLE "org_subscriptions" ADD CONSTRAINT "org_subscriptions_orgId_organizations_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organizations" ADD CONSTRAINT "organizations_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_drives_org_id_idx" ON "org_drives" USING btree ("orgId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_drives_drive_id_idx" ON "org_drives" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_members_org_id_idx" ON "org_members" USING btree ("orgId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_members_user_id_idx" ON "org_members" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_subscriptions_org_id_idx" ON "org_subscriptions" USING btree ("orgId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_subscriptions_stripe_sub_id_idx" ON "org_subscriptions" USING btree ("stripeSubscriptionId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_owner_id_idx" ON "organizations" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_slug_idx" ON "organizations" USING btree ("slug");
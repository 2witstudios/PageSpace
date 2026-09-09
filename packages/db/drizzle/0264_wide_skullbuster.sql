CREATE TYPE "public"."published_app_status" AS ENUM('provisioning', 'building', 'deploying', 'running', 'stopped', 'parked', 'destroying', 'failed');--> statement-breakpoint
CREATE TYPE "public"."published_app_tier" AS ENUM('metered', 'dedicated');--> statement-breakpoint
CREATE TABLE "app_deploy_token_mints" (
	"id" text PRIMARY KEY NOT NULL,
	"publishedAppId" text NOT NULL,
	"flyAppName" text NOT NULL,
	"mintedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiry" text NOT NULL,
	"purpose" text NOT NULL,
	CONSTRAINT "app_deploy_token_mints_expiry_nonempty" CHECK (length("app_deploy_token_mints"."expiry") > 0),
	CONSTRAINT "app_deploy_token_mints_purpose_nonempty" CHECK (length("app_deploy_token_mints"."purpose") > 0)
);
--> statement-breakpoint
CREATE TABLE "app_hosting_reclaims" (
	"flyAppName" text PRIMARY KEY NOT NULL,
	"publishedAppId" text,
	"machineId" text,
	"recordedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastAttemptAt" timestamp with time zone,
	"lastError" text,
	CONSTRAINT "app_hosting_reclaims_attempts_nonneg" CHECK ("app_hosting_reclaims"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "published_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"envId" text NOT NULL,
	"driveId" text NOT NULL,
	"ownerId" text NOT NULL,
	"flyAppName" text NOT NULL,
	"networkName" text NOT NULL,
	"subdomain" text NOT NULL,
	"status" "published_app_status" DEFAULT 'provisioning' NOT NULL,
	"guestPreset" text DEFAULT 'shared-cpu-1x-512' NOT NULL,
	"imageDigest" text,
	"tier" "published_app_tier" DEFAULT 'metered' NOT NULL,
	"machineId" text,
	"lastWakeAt" timestamp with time zone,
	"lastStopAt" timestamp with time zone,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "published_apps_envId_unique" UNIQUE("envId"),
	CONSTRAINT "published_apps_flyAppName_unique" UNIQUE("flyAppName"),
	CONSTRAINT "published_apps_subdomain_unique" UNIQUE("subdomain"),
	CONSTRAINT "published_apps_serving_requires_image" CHECK ("published_apps"."status" NOT IN ('running', 'deploying') OR "published_apps"."imageDigest" IS NOT NULL),
	CONSTRAINT "published_apps_running_requires_machine" CHECK ("published_apps"."status" <> 'running' OR "published_apps"."machineId" IS NOT NULL),
	CONSTRAINT "published_apps_parked_is_metered_only" CHECK ("published_apps"."status" <> 'parked' OR "published_apps"."tier" = 'metered'),
	CONSTRAINT "published_apps_guest_preset_allowed" CHECK ("published_apps"."guestPreset" IN ('shared-cpu-1x-512')),
	CONSTRAINT "published_apps_subdomain_nonempty" CHECK (length("published_apps"."subdomain") > 0)
);
--> statement-breakpoint
ALTER TABLE "app_deploy_token_mints" ADD CONSTRAINT "app_deploy_token_mints_publishedAppId_published_apps_id_fk" FOREIGN KEY ("publishedAppId") REFERENCES "public"."published_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_apps" ADD CONSTRAINT "published_apps_envId_drive_envs_id_fk" FOREIGN KEY ("envId") REFERENCES "public"."drive_envs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_apps" ADD CONSTRAINT "published_apps_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_apps" ADD CONSTRAINT "published_apps_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_deploy_token_mints_app_idx" ON "app_deploy_token_mints" USING btree ("publishedAppId","mintedAt");--> statement-breakpoint
CREATE INDEX "app_hosting_reclaims_recorded_at_idx" ON "app_hosting_reclaims" USING btree ("recordedAt");--> statement-breakpoint
CREATE INDEX "published_apps_drive_idx" ON "published_apps" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX "published_apps_owner_idx" ON "published_apps" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX "published_apps_status_idx" ON "published_apps" USING btree ("status","updatedAt");
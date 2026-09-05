CREATE TABLE "drive_env_local" (
	"envId" text PRIMARY KEY NOT NULL,
	"substrate" text DEFAULT 'local' NOT NULL,
	"label" text NOT NULL,
	"enrollmentId" text NOT NULL,
	"machinePublicKey" text NOT NULL,
	"machineKeyFingerprint" text NOT NULL,
	"serverKeyId" text NOT NULL,
	"capabilities" jsonb,
	"serverPolicy" jsonb DEFAULT '{"ops":[],"checkpoint":false}'::jsonb NOT NULL,
	"bindPolicy" text DEFAULT 'owner' NOT NULL,
	"lastSeenAt" timestamp,
	"enrolledAt" timestamp,
	"revokedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "drive_env_local_enrollment_id_unique" UNIQUE("enrollmentId"),
	CONSTRAINT "drive_env_local_substrate_check" CHECK ("drive_env_local"."substrate" = 'local'),
	CONSTRAINT "drive_env_local_bind_policy_check" CHECK ("drive_env_local"."bindPolicy" IN ('owner', 'admins', 'members'))
);
--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD CONSTRAINT "drive_env_local_envId_substrate_drive_envs_id_substrate_fk" FOREIGN KEY ("envId","substrate") REFERENCES "public"."drive_envs"("id","substrate") ON DELETE cascade ON UPDATE no action;
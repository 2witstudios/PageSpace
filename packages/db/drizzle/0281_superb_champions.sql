CREATE TABLE "drive_env_local" (
	"envId" text PRIMARY KEY NOT NULL,
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
	CONSTRAINT "drive_env_local_bind_policy_check" CHECK ("drive_env_local"."bindPolicy" IN ('owner', 'admins', 'members'))
);
--> statement-breakpoint
ALTER TABLE "drive_envs" ADD COLUMN "substrate" text DEFAULT 'sprite' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD CONSTRAINT "drive_env_local_envId_drive_envs_id_fk" FOREIGN KEY ("envId") REFERENCES "public"."drive_envs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_envs" ADD CONSTRAINT "drive_envs_substrate_check" CHECK ("drive_envs"."substrate" IN ('sprite', 'local'));--> statement-breakpoint
ALTER TABLE "drive_envs" ADD CONSTRAINT "drive_envs_local_no_sprite_check" CHECK ("drive_envs"."substrate" = 'sprite' OR ("drive_envs"."spriteKey" IS NULL AND "drive_envs"."sandboxId" IS NULL AND "drive_envs"."spriteInstanceId" IS NULL));
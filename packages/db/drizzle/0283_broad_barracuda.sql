ALTER TABLE "drive_env_local" ALTER COLUMN "machinePublicKey" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_env_local" ALTER COLUMN "machineKeyFingerprint" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_env_local" ALTER COLUMN "serverKeyId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD COLUMN "enrollmentCodeHash" text;--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD COLUMN "enrollmentCodeExpiresAt" timestamp;--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD COLUMN "enrollmentCodeUsedAt" timestamp;--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD COLUMN "challengeNonce" text;--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD COLUMN "challengeExpiresAt" timestamp;--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD COLUMN "challengeUsedAt" timestamp;--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD CONSTRAINT "drive_env_local_enrolled_has_key_check" CHECK ("drive_env_local"."enrolledAt" IS NULL OR ("drive_env_local"."machinePublicKey" IS NOT NULL AND "drive_env_local"."machineKeyFingerprint" IS NOT NULL AND "drive_env_local"."serverKeyId" IS NOT NULL));
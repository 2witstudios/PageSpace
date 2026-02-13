ALTER TABLE "users" ALTER COLUMN "currentAiModel" SET DEFAULT 'glm-4.7';--> statement-breakpoint
ALTER TABLE "integration_audit_log" ALTER COLUMN "drive_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "admin_role_version" integer DEFAULT 0 NOT NULL;
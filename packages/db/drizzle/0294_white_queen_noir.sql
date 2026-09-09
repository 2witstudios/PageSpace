CREATE TABLE "drive_env_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"envId" text NOT NULL,
	"userId" text,
	"op" text NOT NULL,
	"summary" text NOT NULL,
	"scope" text NOT NULL,
	"createdAt" timestamp NOT NULL,
	"expiresAt" timestamp,
	"revokedAt" timestamp,
	"revokedBy" text,
	"revokeAcknowledgedAt" timestamp,
	"revokeRemoved" integer,
	CONSTRAINT "drive_env_approvals_scope_check" CHECK ("drive_env_approvals"."scope" IN ('session', '30d', 'until_revoked')),
	CONSTRAINT "drive_env_approvals_ack_needs_revoke_check" CHECK ("drive_env_approvals"."revokeAcknowledgedAt" IS NULL OR "drive_env_approvals"."revokedAt" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "drive_env_approvals" ADD CONSTRAINT "drive_env_approvals_envId_drive_envs_id_fk" FOREIGN KEY ("envId") REFERENCES "public"."drive_envs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_env_approvals" ADD CONSTRAINT "drive_env_approvals_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_env_approvals_env_idx" ON "drive_env_approvals" USING btree ("envId","createdAt");--> statement-breakpoint
CREATE INDEX "drive_env_approvals_user_idx" ON "drive_env_approvals" USING btree ("userId","createdAt");
CREATE TABLE "drive_env_grant_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"envId" text NOT NULL,
	"grantId" text,
	"userId" text,
	"sessionId" text NOT NULL,
	"conversationId" text NOT NULL,
	"op" text NOT NULL,
	"argsHash" text NOT NULL,
	"summary" text NOT NULL,
	"verdict" text NOT NULL,
	"exitCode" integer,
	"challengeId" text,
	"approvalScope" text,
	"ts" timestamp DEFAULT now() NOT NULL,
	"resultAt" timestamp,
	CONSTRAINT "drive_env_grant_audit_op_check" CHECK ("drive_env_grant_audit"."op" IN ('exec', 'fs_read', 'fs_write', 'pty_open')),
	CONSTRAINT "drive_env_grant_audit_grant_id_refused_check" CHECK (("drive_env_grant_audit"."grantId" IS NULL) = ("drive_env_grant_audit"."verdict" LIKE 'refused:%'))
);
--> statement-breakpoint
CREATE TABLE "drive_env_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"envId" text NOT NULL,
	"userId" text,
	"op" text NOT NULL,
	"summary" text NOT NULL,
	"scope" text NOT NULL,
	"daemonEpoch" text,
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
ALTER TABLE "drive_env_local" DROP CONSTRAINT "drive_env_local_bind_policy_check";--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD COLUMN "daemonEpoch" text;--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD COLUMN "ownerCredentials" jsonb;--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD COLUMN "pausedAt" timestamp;--> statement-breakpoint
ALTER TABLE "drive_env_grant_audit" ADD CONSTRAINT "drive_env_grant_audit_envId_drive_envs_id_fk" FOREIGN KEY ("envId") REFERENCES "public"."drive_envs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_env_grant_audit" ADD CONSTRAINT "drive_env_grant_audit_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_env_approvals" ADD CONSTRAINT "drive_env_approvals_envId_drive_envs_id_fk" FOREIGN KEY ("envId") REFERENCES "public"."drive_envs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_env_approvals" ADD CONSTRAINT "drive_env_approvals_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_env_grant_audit_env_ts_idx" ON "drive_env_grant_audit" USING btree ("envId","ts");--> statement-breakpoint
CREATE INDEX "drive_env_grant_audit_user_ts_idx" ON "drive_env_grant_audit" USING btree ("userId","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_env_grant_audit_grant_id_unique" ON "drive_env_grant_audit" USING btree ("grantId") WHERE "drive_env_grant_audit"."grantId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "drive_env_approvals_env_idx" ON "drive_env_approvals" USING btree ("envId","createdAt");--> statement-breakpoint
CREATE INDEX "drive_env_approvals_user_idx" ON "drive_env_approvals" USING btree ("userId","createdAt");--> statement-breakpoint
ALTER TABLE "drive_env_local" ADD CONSTRAINT "drive_env_local_bind_policy_check" CHECK ("drive_env_local"."bindPolicy" IN ('owner'));
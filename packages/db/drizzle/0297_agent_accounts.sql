CREATE TYPE "public"."agent_account_acknowledgment" AS ENUM('dedicated_agent_account', 'personal_login_acknowledged');--> statement-breakpoint
CREATE TYPE "public"."agent_account_approval_outcome" AS ENUM('allow_once', 'always', 'deny');--> statement-breakpoint
CREATE TYPE "public"."agent_account_kind" AS ENUM('api_key', 'bearer', 'oauth2', 'session', 'password');--> statement-breakpoint
CREATE TYPE "public"."agent_account_owner_kind" AS ENUM('user', 'agent_page');--> statement-breakpoint
CREATE TYPE "public"."agent_account_session_format" AS ENUM('cookie-jar-v1', 'storage-state-v1', 'human-relogin');--> statement-breakpoint
CREATE TYPE "public"."agent_account_status" AS ENUM('active', 'revoked', 'needs_reauth', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."agent_account_upstream_revocation" AS ENUM('not_attempted', 'revoked', 'unsupported', 'failed');--> statement-breakpoint
CREATE TABLE "agent_account_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"requestDigest" text NOT NULL,
	"outcome" "agent_account_approval_outcome" NOT NULL,
	"approvedByUserId" text NOT NULL,
	"approvedViaSessionId" text NOT NULL,
	"stepUpChallengeId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"consumedAt" timestamp with time zone,
	"consumedByGrantId" text,
	CONSTRAINT "agent_account_approvals_consumed_chk" CHECK (("agent_account_approvals"."consumedAt" IS NULL) = ("agent_account_approvals"."consumedByGrantId" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "agent_account_bindings" (
	"accountId" text NOT NULL,
	"agentPageId" text NOT NULL,
	"boundByUserId" text NOT NULL,
	"boundAt" timestamp with time zone DEFAULT now() NOT NULL,
	"revokedAt" timestamp with time zone,
	CONSTRAINT "agent_account_bindings_accountId_agentPageId_pk" PRIMARY KEY("accountId","agentPageId")
);
--> statement-breakpoint
CREATE TABLE "agent_account_delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"agentPageId" text,
	"delegatedByUserId" text NOT NULL,
	"scope" jsonb NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"revokedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "agent_account_kind" NOT NULL,
	"ownerKind" "agent_account_owner_kind" NOT NULL,
	"ownerUserId" text,
	"ownerAgentPageId" text,
	"ownerDriveId" text,
	"tenantId" text NOT NULL,
	"name" text NOT NULL,
	"providerSlug" text,
	"allowedOrigins" jsonb NOT NULL,
	"auxiliaryOrigins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resourceRestrictions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approvalPolicy" jsonb,
	"credentialVersion" integer DEFAULT 0 NOT NULL,
	"policyVersion" integer DEFAULT 1 NOT NULL,
	"acknowledgment" "agent_account_acknowledgment" NOT NULL,
	"sessionFormat" "agent_account_session_format",
	"sessionHttpEnabled" boolean DEFAULT false NOT NULL,
	"status" "agent_account_status" DEFAULT 'active' NOT NULL,
	"upstreamRevocation" "agent_account_upstream_revocation",
	"lastUsedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"revokedAt" timestamp with time zone,
	CONSTRAINT "agent_accounts_owner_scope_chk" CHECK (("agent_accounts"."ownerKind" = 'user' AND "agent_accounts"."ownerUserId" IS NOT NULL AND "agent_accounts"."ownerAgentPageId" IS NULL AND "agent_accounts"."ownerDriveId" IS NULL)
        OR ("agent_accounts"."ownerKind" = 'agent_page' AND "agent_accounts"."ownerUserId" IS NULL AND "agent_accounts"."ownerAgentPageId" IS NOT NULL AND "agent_accounts"."ownerDriveId" IS NOT NULL)),
	CONSTRAINT "agent_accounts_tenant_derived_chk" CHECK (("agent_accounts"."ownerKind" = 'user' AND "agent_accounts"."tenantId" = 'user:' || "agent_accounts"."ownerUserId")
        OR ("agent_accounts"."ownerKind" = 'agent_page' AND "agent_accounts"."tenantId" = 'drive:' || "agent_accounts"."ownerDriveId")),
	CONSTRAINT "agent_accounts_allowed_origins_nonempty_chk" CHECK (jsonb_typeof("agent_accounts"."allowedOrigins") = 'array' AND jsonb_array_length("agent_accounts"."allowedOrigins") > 0),
	CONSTRAINT "agent_accounts_session_format_chk" CHECK (("agent_accounts"."kind" = 'session') = ("agent_accounts"."sessionFormat" IS NOT NULL)),
	CONSTRAINT "agent_accounts_session_http_chk" CHECK ("agent_accounts"."sessionHttpEnabled" = false OR "agent_accounts"."kind" = 'session'),
	CONSTRAINT "agent_accounts_versions_chk" CHECK ("agent_accounts"."credentialVersion" >= 0 AND "agent_accounts"."policyVersion" >= 1)
);
--> statement-breakpoint
ALTER TABLE "agent_account_approvals" ADD CONSTRAINT "agent_account_approvals_accountId_agent_accounts_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."agent_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_approvals" ADD CONSTRAINT "agent_account_approvals_approvedByUserId_users_id_fk" FOREIGN KEY ("approvedByUserId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_bindings" ADD CONSTRAINT "agent_account_bindings_accountId_agent_accounts_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."agent_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_bindings" ADD CONSTRAINT "agent_account_bindings_agentPageId_pages_id_fk" FOREIGN KEY ("agentPageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_bindings" ADD CONSTRAINT "agent_account_bindings_boundByUserId_users_id_fk" FOREIGN KEY ("boundByUserId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_delegations" ADD CONSTRAINT "agent_account_delegations_accountId_agent_accounts_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."agent_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_delegations" ADD CONSTRAINT "agent_account_delegations_agentPageId_pages_id_fk" FOREIGN KEY ("agentPageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_delegations" ADD CONSTRAINT "agent_account_delegations_delegatedByUserId_users_id_fk" FOREIGN KEY ("delegatedByUserId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_accounts" ADD CONSTRAINT "agent_accounts_ownerUserId_users_id_fk" FOREIGN KEY ("ownerUserId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_accounts" ADD CONSTRAINT "agent_accounts_ownerAgentPageId_pages_id_fk" FOREIGN KEY ("ownerAgentPageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_accounts" ADD CONSTRAINT "agent_accounts_ownerDriveId_drives_id_fk" FOREIGN KEY ("ownerDriveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_account_approvals_account_digest_idx" ON "agent_account_approvals" USING btree ("accountId","requestDigest");--> statement-breakpoint
CREATE INDEX "agent_account_bindings_agent_page_id_idx" ON "agent_account_bindings" USING btree ("agentPageId");--> statement-breakpoint
CREATE INDEX "agent_account_delegations_account_id_idx" ON "agent_account_delegations" USING btree ("accountId");--> statement-breakpoint
CREATE INDEX "agent_accounts_owner_user_id_idx" ON "agent_accounts" USING btree ("ownerUserId");--> statement-breakpoint
CREATE INDEX "agent_accounts_owner_agent_page_id_idx" ON "agent_accounts" USING btree ("ownerAgentPageId");--> statement-breakpoint
CREATE INDEX "agent_accounts_owner_drive_id_idx" ON "agent_accounts" USING btree ("ownerDriveId");
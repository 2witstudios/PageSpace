CREATE TYPE "public"."AccountType" AS ENUM('human', 'agent');--> statement-breakpoint
CREATE TABLE "agent_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"agentUserId" text NOT NULL,
	"ownerUserId" text,
	"userCodeHash" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"approvedAt" timestamp,
	"deniedAt" timestamp,
	"redeemedAt" timestamp,
	"lastPolledAt" timestamp,
	"pollIntervalSeconds" integer DEFAULT 5 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_claims_userCodeHash_unique" UNIQUE("userCodeHash")
);
--> statement-breakpoint
CREATE TABLE "agent_identities" (
	"userId" text PRIMARY KEY NOT NULL,
	"secretHash" text NOT NULL,
	"secretPrefix" text NOT NULL,
	"secretVersion" integer DEFAULT 1 NOT NULL,
	"claimTokenHash" text,
	"claimTokenPrefix" text,
	"source" varchar(120),
	"ownerUserId" text,
	"claimedAt" timestamp,
	"createdByIp" text,
	"lastAuthAt" timestamp,
	"revokedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_identities_secretHash_unique" UNIQUE("secretHash"),
	CONSTRAINT "agent_identities_claimTokenHash_unique" UNIQUE("claimTokenHash")
);
--> statement-breakpoint
CREATE TABLE "agent_signup_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"challengeHash" text NOT NULL,
	"difficultyBits" integer NOT NULL,
	"issuedToIp" text,
	"expiresAt" timestamp NOT NULL,
	"consumedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_signup_challenges_challengeHash_unique" UNIQUE("challengeHash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accountType" "AccountType" DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_claims" ADD CONSTRAINT "agent_claims_agentUserId_users_id_fk" FOREIGN KEY ("agentUserId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_claims" ADD CONSTRAINT "agent_claims_ownerUserId_users_id_fk" FOREIGN KEY ("ownerUserId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_ownerUserId_users_id_fk" FOREIGN KEY ("ownerUserId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_claims_agent_user_id_idx" ON "agent_claims" USING btree ("agentUserId");--> statement-breakpoint
CREATE INDEX "agent_claims_owner_user_id_idx" ON "agent_claims" USING btree ("ownerUserId");--> statement-breakpoint
CREATE INDEX "agent_claims_expires_at_idx" ON "agent_claims" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "agent_identities_owner_user_id_idx" ON "agent_identities" USING btree ("ownerUserId");--> statement-breakpoint
CREATE INDEX "agent_signup_challenges_expires_at_idx" ON "agent_signup_challenges" USING btree ("expiresAt");
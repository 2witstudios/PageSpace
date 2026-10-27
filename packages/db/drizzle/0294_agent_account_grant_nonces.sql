CREATE TABLE "agent_account_grant_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"grantId" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"consumedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_account_grant_nonces_expires_at_idx" ON "agent_account_grant_nonces" USING btree ("expiresAt");
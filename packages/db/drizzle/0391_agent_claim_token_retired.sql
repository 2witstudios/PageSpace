ALTER TABLE "agent_identities" DROP CONSTRAINT "agent_identities_claimTokenHash_unique";--> statement-breakpoint
DROP INDEX "agent_claims_claim_token_hash_idx";--> statement-breakpoint
DROP INDEX "agent_claims_agent_user_id_idx";--> statement-breakpoint
CREATE INDEX "agent_claims_agent_user_id_idx" ON "agent_claims" USING btree ("agentUserId","createdAt");--> statement-breakpoint
ALTER TABLE "agent_claims" DROP COLUMN "claimTokenHash";--> statement-breakpoint
ALTER TABLE "agent_identities" DROP COLUMN "claimTokenHash";--> statement-breakpoint
ALTER TABLE "agent_identities" DROP COLUMN "claimTokenPrefix";
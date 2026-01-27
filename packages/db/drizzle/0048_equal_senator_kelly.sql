ALTER TABLE "device_tokens" DROP CONSTRAINT "device_tokens_token_unique";--> statement-breakpoint
ALTER TABLE "mcp_tokens" DROP CONSTRAINT "mcp_tokens_token_unique";--> statement-breakpoint
ALTER TABLE "verification_tokens" DROP CONSTRAINT "verification_tokens_token_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "device_tokens_token_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "device_tokens_token_hash_partial_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_tokens_token_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_tokens_token_hash_partial_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "verification_tokens_token_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "verification_tokens_token_hash_partial_idx";--> statement-breakpoint
ALTER TABLE "device_tokens" ALTER COLUMN "tokenHash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "device_tokens" ALTER COLUMN "tokenPrefix" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ALTER COLUMN "tokenHash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ALTER COLUMN "tokenPrefix" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_tokens" ALTER COLUMN "tokenHash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_tokens" ALTER COLUMN "tokenPrefix" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_tokens_token_hash_idx" ON "device_tokens" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tokens_token_hash_idx" ON "mcp_tokens" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_tokens_token_hash_idx" ON "verification_tokens" USING btree ("tokenHash");--> statement-breakpoint
ALTER TABLE "device_tokens" DROP COLUMN IF EXISTS "token";--> statement-breakpoint
ALTER TABLE "mcp_tokens" DROP COLUMN IF EXISTS "token";--> statement-breakpoint
ALTER TABLE "verification_tokens" DROP COLUMN IF EXISTS "token";--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_tokenHash_unique" UNIQUE("tokenHash");--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_tokenHash_unique" UNIQUE("tokenHash");--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_tokenHash_unique" UNIQUE("tokenHash");
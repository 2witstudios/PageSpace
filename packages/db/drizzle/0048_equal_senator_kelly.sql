-- STEP 1: Backfill tokenHash from token column where NULL
-- (token column already stores hash values, so we copy them over)
UPDATE "device_tokens" SET "tokenHash" = "token" WHERE "tokenHash" IS NULL;--> statement-breakpoint
UPDATE "device_tokens" SET "tokenPrefix" = LEFT("token", 12) WHERE "tokenPrefix" IS NULL;--> statement-breakpoint
UPDATE "mcp_tokens" SET "tokenHash" = "token" WHERE "tokenHash" IS NULL;--> statement-breakpoint
UPDATE "mcp_tokens" SET "tokenPrefix" = LEFT("token", 12) WHERE "tokenPrefix" IS NULL;--> statement-breakpoint
UPDATE "verification_tokens" SET "tokenHash" = "token" WHERE "tokenHash" IS NULL;--> statement-breakpoint
UPDATE "verification_tokens" SET "tokenPrefix" = LEFT("token", 12) WHERE "tokenPrefix" IS NULL;--> statement-breakpoint

-- STEP 2: Drop old constraints and indexes
ALTER TABLE "device_tokens" DROP CONSTRAINT "device_tokens_token_unique";--> statement-breakpoint
ALTER TABLE "mcp_tokens" DROP CONSTRAINT "mcp_tokens_token_unique";--> statement-breakpoint
ALTER TABLE "verification_tokens" DROP CONSTRAINT "verification_tokens_token_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "device_tokens_token_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "device_tokens_token_hash_partial_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_tokens_token_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_tokens_token_hash_partial_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "verification_tokens_token_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "verification_tokens_token_hash_partial_idx";--> statement-breakpoint

-- STEP 3: Set NOT NULL (now safe after backfill)
ALTER TABLE "device_tokens" ALTER COLUMN "tokenHash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "device_tokens" ALTER COLUMN "tokenPrefix" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ALTER COLUMN "tokenHash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ALTER COLUMN "tokenPrefix" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_tokens" ALTER COLUMN "tokenHash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_tokens" ALTER COLUMN "tokenPrefix" SET NOT NULL;--> statement-breakpoint

-- STEP 4: Create new indexes
CREATE INDEX IF NOT EXISTS "device_tokens_token_hash_idx" ON "device_tokens" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tokens_token_hash_idx" ON "mcp_tokens" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_tokens_token_hash_idx" ON "verification_tokens" USING btree ("tokenHash");--> statement-breakpoint

-- STEP 5: Drop the now-redundant token column
ALTER TABLE "device_tokens" DROP COLUMN IF EXISTS "token";--> statement-breakpoint
ALTER TABLE "mcp_tokens" DROP COLUMN IF EXISTS "token";--> statement-breakpoint
ALTER TABLE "verification_tokens" DROP COLUMN IF EXISTS "token";--> statement-breakpoint

-- STEP 6: Add unique constraints on tokenHash
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_tokenHash_unique" UNIQUE("tokenHash");--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_tokenHash_unique" UNIQUE("tokenHash");--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_tokenHash_unique" UNIQUE("tokenHash");

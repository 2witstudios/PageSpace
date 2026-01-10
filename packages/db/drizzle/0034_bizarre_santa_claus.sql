ALTER TABLE "device_tokens" ADD COLUMN "tokenHash" text;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD COLUMN "tokenPrefix" text;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD COLUMN "tokenHash" text;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD COLUMN "tokenPrefix" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_tokens_token_hash_partial_idx" ON "device_tokens" USING btree ("tokenHash") WHERE "device_tokens"."tokenHash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verification_tokens_token_hash_partial_idx" ON "verification_tokens" USING btree ("tokenHash") WHERE "verification_tokens"."tokenHash" IS NOT NULL;
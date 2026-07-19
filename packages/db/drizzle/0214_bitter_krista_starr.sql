-- Plaintext tokens are being replaced by a one-way SHA3-256 hash (never
-- reversible), so pre-existing rows cannot be backfilled — their raw token
-- is about to be dropped. Wipe them; they are revocable, user-regeneratable
-- credentials, not durable data (hard cutover, no backwards-compat, per
-- project convention for unreleased/low-stakes state).
DELETE FROM "drive_share_links";--> statement-breakpoint
DELETE FROM "page_share_links";--> statement-breakpoint
ALTER TABLE "drive_share_links" DROP CONSTRAINT "drive_share_links_token_unique";--> statement-breakpoint
ALTER TABLE "page_share_links" DROP CONSTRAINT "page_share_links_token_unique";--> statement-breakpoint
ALTER TABLE "drive_share_links" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "page_share_links" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_share_links" DROP COLUMN IF EXISTS "token";--> statement-breakpoint
ALTER TABLE "page_share_links" DROP COLUMN IF EXISTS "token";--> statement-breakpoint
ALTER TABLE "drive_share_links" ADD CONSTRAINT "drive_share_links_token_hash_unique" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "page_share_links" ADD CONSTRAINT "page_share_links_token_hash_unique" UNIQUE("token_hash");
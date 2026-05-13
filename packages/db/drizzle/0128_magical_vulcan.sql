ALTER TABLE "drive_share_links" DROP CONSTRAINT "drive_share_links_token_hash_unique";--> statement-breakpoint
ALTER TABLE "page_share_links" DROP CONSTRAINT "page_share_links_token_hash_unique";--> statement-breakpoint
ALTER TABLE "drive_share_links" ALTER COLUMN "token" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "page_share_links" ALTER COLUMN "token" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "drive_share_links" DROP COLUMN IF EXISTS "token_hash";--> statement-breakpoint
ALTER TABLE "page_share_links" DROP COLUMN IF EXISTS "token_hash";--> statement-breakpoint
ALTER TABLE "drive_share_links" ADD CONSTRAINT "drive_share_links_token_unique" UNIQUE("token");--> statement-breakpoint
ALTER TABLE "page_share_links" ADD CONSTRAINT "page_share_links_token_unique" UNIQUE("token");
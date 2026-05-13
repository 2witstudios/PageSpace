ALTER TABLE "pending_invites" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_page_invites" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_share_links" ADD COLUMN "token" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "page_share_links" ADD COLUMN "token" text DEFAULT '' NOT NULL;
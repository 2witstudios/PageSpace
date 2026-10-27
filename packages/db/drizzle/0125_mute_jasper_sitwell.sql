ALTER TABLE "pending_invites" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_page_invites" ALTER COLUMN "expires_at" DROP NOT NULL;
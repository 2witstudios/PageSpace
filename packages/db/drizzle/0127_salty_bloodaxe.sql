ALTER TABLE "pending_invites" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_page_invites" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "toolAccessScope" text DEFAULT 'drive' NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_toolAccessScope_check" CHECK ("toolAccessScope" IN ('drive', 'subtree'));
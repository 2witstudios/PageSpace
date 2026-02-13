ALTER TYPE "display_preference_type" ADD VALUE 'DEFAULT_MARKDOWN_MODE';--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "contentMode" text DEFAULT 'html' NOT NULL;
ALTER TABLE "pages" ADD COLUMN "aiSystemPrompt" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "aiDescription" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "aiToolAccess" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "aiModelOverride" text;
ALTER TABLE "pages" ADD COLUMN "systemPrompt" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "enabledTools" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "agentName" text;
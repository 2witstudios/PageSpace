ALTER TABLE "pages" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "allowPageAgents" boolean DEFAULT true NOT NULL;
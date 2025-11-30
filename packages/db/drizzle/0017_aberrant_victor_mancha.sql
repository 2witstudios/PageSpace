ALTER TABLE "pages" ADD COLUMN "agentDefinition" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "visibleToGlobalAssistant" boolean DEFAULT true;
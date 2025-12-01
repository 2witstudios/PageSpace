ALTER TABLE "pages" ADD COLUMN "includePageTree" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "pageTreeScope" text DEFAULT 'children';
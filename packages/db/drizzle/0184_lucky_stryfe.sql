ALTER TABLE "pages" ADD COLUMN "terminalAccess" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "machines" jsonb;
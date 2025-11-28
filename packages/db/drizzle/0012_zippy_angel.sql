ALTER TABLE "drives" ADD COLUMN "drivePrompt" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "includeDrivePrompt" boolean DEFAULT false;
ALTER TABLE "pages" ALTER COLUMN "includeDrivePrompt" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ALTER COLUMN "visibleToGlobalAssistant" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ALTER COLUMN "includePageTree" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_backup_roles" ALTER COLUMN "position" SET DATA TYPE real;
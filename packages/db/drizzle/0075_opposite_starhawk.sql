ALTER TABLE "calendar_events" ALTER COLUMN "googleSyncReadOnly" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "google_calendar_connections" ALTER COLUMN "markAsReadOnly" SET DEFAULT false;
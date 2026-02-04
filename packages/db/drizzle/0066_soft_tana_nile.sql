DO $$ BEGIN
 CREATE TYPE "public"."GoogleCalendarConnectionStatus" AS ENUM('active', 'expired', 'error', 'disconnected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_calendar_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text NOT NULL,
	"refreshToken" text NOT NULL,
	"tokenExpiresAt" timestamp with time zone NOT NULL,
	"googleEmail" text NOT NULL,
	"googleAccountId" text NOT NULL,
	"status" "GoogleCalendarConnectionStatus" DEFAULT 'active' NOT NULL,
	"statusMessage" text,
	"targetDriveId" text,
	"selectedCalendars" jsonb DEFAULT '[]'::jsonb,
	"syncFrequencyMinutes" integer DEFAULT 15 NOT NULL,
	"markAsReadOnly" boolean DEFAULT true NOT NULL,
	"lastSyncAt" timestamp with time zone,
	"lastSyncError" text,
	"syncCursor" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "google_calendar_connections_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "googleEventId" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "googleCalendarId" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "syncedFromGoogle" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "lastGoogleSync" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "googleSyncReadOnly" boolean DEFAULT true;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_targetDriveId_drives_id_fk" FOREIGN KEY ("targetDriveId") REFERENCES "public"."drives"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_calendar_connections_user_id_idx" ON "google_calendar_connections" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_calendar_connections_status_idx" ON "google_calendar_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_calendar_connections_target_drive_id_idx" ON "google_calendar_connections" USING btree ("targetDriveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_google_event_id_idx" ON "calendar_events" USING btree ("googleEventId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_synced_from_google_idx" ON "calendar_events" USING btree ("syncedFromGoogle");
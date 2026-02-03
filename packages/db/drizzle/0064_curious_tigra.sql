DO $$ BEGIN
 CREATE TYPE "public"."AttendeeStatus" AS ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'TENTATIVE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."EventVisibility" AS ENUM('DRIVE', 'ATTENDEES_ONLY', 'PRIVATE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."RecurrenceFrequency" AS ENUM('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_events" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text,
	"createdById" text NOT NULL,
	"pageId" text,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"startAt" timestamp with time zone NOT NULL,
	"endAt" timestamp with time zone NOT NULL,
	"allDay" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"recurrenceRule" jsonb,
	"recurrenceExceptions" jsonb DEFAULT '[]'::jsonb,
	"recurringEventId" text,
	"originalStartAt" timestamp with time zone,
	"visibility" "EventVisibility" DEFAULT 'DRIVE' NOT NULL,
	"color" text DEFAULT 'default',
	"metadata" jsonb,
	"isTrashed" boolean DEFAULT false NOT NULL,
	"trashedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_attendees" (
	"id" text PRIMARY KEY NOT NULL,
	"eventId" text NOT NULL,
	"userId" text NOT NULL,
	"status" "AttendeeStatus" DEFAULT 'PENDING' NOT NULL,
	"responseNote" text,
	"isOrganizer" boolean DEFAULT false NOT NULL,
	"isOptional" boolean DEFAULT false NOT NULL,
	"invitedAt" timestamp DEFAULT now() NOT NULL,
	"respondedAt" timestamp,
	CONSTRAINT "event_attendees_event_user_key" UNIQUE("eventId","userId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_createdById_users_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_eventId_calendar_events_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_drive_id_idx" ON "calendar_events" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_created_by_id_idx" ON "calendar_events" USING btree ("createdById");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_page_id_idx" ON "calendar_events" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_start_at_idx" ON "calendar_events" USING btree ("startAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_end_at_idx" ON "calendar_events" USING btree ("endAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_drive_id_start_at_idx" ON "calendar_events" USING btree ("driveId","startAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_recurring_event_id_idx" ON "calendar_events" USING btree ("recurringEventId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_is_trashed_idx" ON "calendar_events" USING btree ("isTrashed");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_attendees_event_id_idx" ON "event_attendees" USING btree ("eventId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_attendees_user_id_idx" ON "event_attendees" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_attendees_status_idx" ON "event_attendees" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_attendees_user_id_status_idx" ON "event_attendees" USING btree ("userId","status");
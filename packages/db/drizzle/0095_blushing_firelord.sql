DO $$ BEGIN
 CREATE TYPE "public"."CalendarTriggerStatus" AS ENUM('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"calendarEventId" text NOT NULL,
	"agentPageId" text NOT NULL,
	"driveId" text NOT NULL,
	"scheduledById" text NOT NULL,
	"prompt" text NOT NULL,
	"instructionPageId" text,
	"contextPageIds" jsonb DEFAULT '[]'::jsonb,
	"status" "CalendarTriggerStatus" DEFAULT 'pending' NOT NULL,
	"triggerAt" timestamp with time zone NOT NULL,
	"claimedAt" timestamp with time zone,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone,
	"error" text,
	"durationMs" integer,
	"conversationId" text,
	"occurrenceDate" timestamp with time zone DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "calendar_triggers_event_occurrence_key" UNIQUE("calendarEventId","occurrenceDate")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_triggers" ADD CONSTRAINT "calendar_triggers_calendarEventId_calendar_events_id_fk" FOREIGN KEY ("calendarEventId") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_triggers" ADD CONSTRAINT "calendar_triggers_agentPageId_pages_id_fk" FOREIGN KEY ("agentPageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_triggers" ADD CONSTRAINT "calendar_triggers_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_triggers" ADD CONSTRAINT "calendar_triggers_scheduledById_users_id_fk" FOREIGN KEY ("scheduledById") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_triggers" ADD CONSTRAINT "calendar_triggers_instructionPageId_pages_id_fk" FOREIGN KEY ("instructionPageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_triggers_status_trigger_at_idx" ON "calendar_triggers" USING btree ("status","triggerAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_triggers_scheduled_by_idx" ON "calendar_triggers" USING btree ("scheduledById");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_triggers_agent_page_idx" ON "calendar_triggers" USING btree ("agentPageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_triggers_calendar_event_idx" ON "calendar_triggers" USING btree ("calendarEventId");
CREATE TABLE IF NOT EXISTS "calendar_event_drives" (
	"id" text PRIMARY KEY NOT NULL,
	"eventId" text NOT NULL,
	"driveId" text NOT NULL,
	"sharedBy" text,
	"sharedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_drives_event_drive_key" UNIQUE("eventId","driveId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_event_drives" ADD CONSTRAINT "calendar_event_drives_event_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_event_drives" ADD CONSTRAINT "calendar_event_drives_drive_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_event_drives" ADD CONSTRAINT "calendar_event_drives_shared_by_fk" FOREIGN KEY ("sharedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_event_drives_event_id_idx" ON "calendar_event_drives" USING btree ("eventId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_event_drives_drive_id_idx" ON "calendar_event_drives" USING btree ("driveId");

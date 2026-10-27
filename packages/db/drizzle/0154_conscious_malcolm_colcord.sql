DO $$ BEGIN
 CREATE TYPE "public"."drive_backup_schedule_frequency" AS ENUM('daily', 'weekly', 'monthly');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_backup_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"frequency" "drive_backup_schedule_frequency" DEFAULT 'daily' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"nextRunAt" timestamp,
	"lastRunAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "drive_backup_schedules_driveId_unique" UNIQUE("driveId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_backup_schedules" ADD CONSTRAINT "drive_backup_schedules_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_backup_schedules_enabled_next_run_idx" ON "drive_backup_schedules" USING btree ("enabled","nextRunAt");
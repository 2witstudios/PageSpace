--> Written to be RE-RUNNABLE, for the reason 0288 records: this runner keys
--> applied migrations by a hash of the file text, so any edit to a file some
--> database has already applied makes that database run it again, and
--> `db:migrate` is the deployment command. Every statement below is guarded.
--> SPEND-6: the drive lead is told, at most once per period, that an automation
--> was skipped because the drive wallet could not cover it.
ALTER TYPE "public"."NotificationType" ADD VALUE IF NOT EXISTS 'AUTOMATION_SKIPPED' BEFORE 'PRODUCT_UPDATE';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_skip_notices" (
	"driveId" text PRIMARY KEY NOT NULL,
	"lastNotifiedAt" timestamp NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_skip_notices_driveId_drives_id_fk' AND conrelid = '"automation_skip_notices"'::regclass) THEN
		ALTER TABLE "automation_skip_notices" ADD CONSTRAINT "automation_skip_notices_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

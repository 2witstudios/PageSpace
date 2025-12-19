ALTER TABLE "activity_logs" DROP CONSTRAINT "activity_logs_userId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_logs" DROP CONSTRAINT "activity_logs_driveId_drives_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_logs" ALTER COLUMN "userId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_logs" ALTER COLUMN "driveId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "actorEmail" text DEFAULT 'legacy@unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "actorDisplayName" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

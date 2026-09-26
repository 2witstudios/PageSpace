CREATE TYPE "public"."DriveJoinRequestStatus" AS ENUM('pending', 'approved', 'denied', 'withdrawn');--> statement-breakpoint
CREATE TABLE "drive_join_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"userId" text NOT NULL,
	"status" "DriveJoinRequestStatus" DEFAULT 'pending' NOT NULL,
	"message" text,
	"requestedAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	"decidedAt" timestamp,
	"decidedBy" text
);
--> statement-breakpoint
ALTER TABLE "drive_join_requests" ADD CONSTRAINT "drive_join_requests_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_join_requests" ADD CONSTRAINT "drive_join_requests_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_join_requests" ADD CONSTRAINT "drive_join_requests_decidedBy_users_id_fk" FOREIGN KEY ("decidedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_join_requests_one_pending_key" ON "drive_join_requests" USING btree ("driveId","userId") WHERE "drive_join_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "drive_join_requests_drive_status_idx" ON "drive_join_requests" USING btree ("driveId","status");--> statement-breakpoint
CREATE INDEX "drive_join_requests_user_id_idx" ON "drive_join_requests" USING btree ("userId");
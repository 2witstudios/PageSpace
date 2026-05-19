DO $$ BEGIN
 CREATE TYPE "public"."ZoomConnectionStatus" AS ENUM('active', 'expired', 'error', 'disconnected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zoom_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text NOT NULL,
	"refreshToken" text,
	"tokenExpiresAt" timestamp with time zone,
	"zoomUserId" text NOT NULL,
	"zoomAccountId" text NOT NULL,
	"zoomEmail" text NOT NULL,
	"status" "ZoomConnectionStatus" DEFAULT 'active' NOT NULL,
	"targetDriveId" text,
	"targetFolderId" text,
	"includeAiSummary" boolean DEFAULT true NOT NULL,
	"includeActionItems" boolean DEFAULT true NOT NULL,
	"includeTranscript" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "zoom_connections_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zoom_connections" ADD CONSTRAINT "zoom_connections_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zoom_connections" ADD CONSTRAINT "zoom_connections_targetDriveId_drives_id_fk" FOREIGN KEY ("targetDriveId") REFERENCES "public"."drives"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoom_connections_user_id_idx" ON "zoom_connections" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoom_connections_status_idx" ON "zoom_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoom_connections_account_id_idx" ON "zoom_connections" USING btree ("zoomAccountId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoom_connections_target_drive_id_idx" ON "zoom_connections" USING btree ("targetDriveId");
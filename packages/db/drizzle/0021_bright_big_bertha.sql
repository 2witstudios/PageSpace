DO $$ BEGIN
 CREATE TYPE "public"."activity_operation" AS ENUM('create', 'update', 'delete', 'restore', 'reorder', 'permission_grant', 'permission_update', 'permission_revoke', 'trash', 'move', 'agent_config_update');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."activity_resource" AS ENUM('page', 'drive', 'permission', 'agent');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"userId" text NOT NULL,
	"isAiGenerated" boolean DEFAULT false NOT NULL,
	"aiProvider" text,
	"aiModel" text,
	"aiConversationId" text,
	"operation" "activity_operation" NOT NULL,
	"resourceType" "activity_resource" NOT NULL,
	"resourceId" text NOT NULL,
	"resourceTitle" text,
	"driveId" text NOT NULL,
	"pageId" text,
	"contentSnapshot" text,
	"updatedFields" jsonb,
	"previousValues" jsonb,
	"newValues" jsonb,
	"metadata" jsonb,
	"isArchived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_logs_timestamp" ON "activity_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_logs_user_timestamp" ON "activity_logs" USING btree ("userId","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_logs_drive_timestamp" ON "activity_logs" USING btree ("driveId","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_logs_page_timestamp" ON "activity_logs" USING btree ("pageId","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_logs_archived" ON "activity_logs" USING btree ("isArchived");
DO $$ BEGIN
 CREATE TYPE "public"."WorkflowRunStatus" AS ENUM('never_run', 'success', 'error', 'running');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"createdBy" text NOT NULL,
	"name" text NOT NULL,
	"agentPageId" text NOT NULL,
	"prompt" text NOT NULL,
	"contextPageIds" jsonb DEFAULT '[]'::jsonb,
	"cronExpression" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"isEnabled" boolean DEFAULT true NOT NULL,
	"lastRunAt" timestamp,
	"nextRunAt" timestamp,
	"lastRunStatus" "WorkflowRunStatus" DEFAULT 'never_run' NOT NULL,
	"lastRunError" text,
	"lastRunDurationMs" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflows" ADD CONSTRAINT "workflows_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflows" ADD CONSTRAINT "workflows_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflows" ADD CONSTRAINT "workflows_agentPageId_pages_id_fk" FOREIGN KEY ("agentPageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_drive_id_idx" ON "workflows" USING btree ("driveId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_created_by_idx" ON "workflows" USING btree ("createdBy");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_agent_page_id_idx" ON "workflows" USING btree ("agentPageId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_enabled_next_run_idx" ON "workflows" USING btree ("isEnabled","nextRunAt");

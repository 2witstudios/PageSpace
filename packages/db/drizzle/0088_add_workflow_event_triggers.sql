DO $$ BEGIN
 CREATE TYPE "public"."WorkflowTriggerType" AS ENUM('cron', 'event');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "cronExpression" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "triggerType" "WorkflowTriggerType" DEFAULT 'cron' NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "eventTriggers" jsonb;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "watchedFolderIds" jsonb;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "eventDebounceSecs" integer DEFAULT 30;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_enabled_trigger_type_idx" ON "workflows" USING btree ("isEnabled","triggerType");

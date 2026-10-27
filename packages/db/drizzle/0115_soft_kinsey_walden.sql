-- Workflow Trigger Decomposition (PR 1/2):
--
--   * Drop workflows.taskItemId and remove the task_due_date / task_completion
--     enum values from WorkflowTriggerType — task triggers move to a peer
--     table.
--   * Create task_triggers (workflowId FK + taskItemId + triggerType +
--     scheduling fields) — one row per (taskItem, triggerType).
--   * Add calendar_triggers.workflowId NOT NULL FK and drop the duplicated
--     execution-payload columns (prompt, agentPageId, instructionPageId,
--     contextPageIds); the workflows row referenced by workflowId is now the
--     single source of truth for execution payload.
--
-- Hard cutover (no nullable bridge column, no dual-write). None of these
-- tables hold meaningful prod data yet, so we TRUNCATE calendar_triggers and
-- drop task-flavored workflows rows so the NOT NULL workflowId column and the
-- recreated enum can be applied without leftover rows violating either.

-- Hard-cutover wipe: remove rows that reference the columns/values being dropped.
TRUNCATE TABLE "calendar_triggers";--> statement-breakpoint
DELETE FROM "workflows" WHERE "triggerType" IN ('task_due_date', 'task_completion');--> statement-breakpoint

-- Drop and recreate WorkflowTriggerType to remove the task-flavored values
-- (Postgres has no DROP VALUE for an enum). Cast through text so any
-- still-valid 'cron' / 'event' rows survive.
ALTER TABLE "workflows" ALTER COLUMN "triggerType" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "WorkflowTriggerType" RENAME TO "WorkflowTriggerType_old";--> statement-breakpoint
CREATE TYPE "WorkflowTriggerType" AS ENUM('cron', 'event');--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "triggerType" TYPE "WorkflowTriggerType" USING ("triggerType"::text::"WorkflowTriggerType");--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "triggerType" SET DEFAULT 'cron';--> statement-breakpoint
DROP TYPE "WorkflowTriggerType_old";--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "public"."TaskTriggerType" AS ENUM('due_date', 'completion');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"workflowId" text NOT NULL,
	"taskItemId" text NOT NULL,
	"triggerType" "TaskTriggerType" NOT NULL,
	"nextRunAt" timestamp,
	"lastFiredAt" timestamp,
	"lastFireError" text,
	"isEnabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "task_triggers_task_item_trigger_type_key" UNIQUE("taskItemId","triggerType")
);
--> statement-breakpoint
ALTER TABLE "workflows" DROP CONSTRAINT "workflows_task_item_trigger_type_key";--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP CONSTRAINT "calendar_triggers_agentPageId_pages_id_fk";
--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP CONSTRAINT "calendar_triggers_instructionPageId_pages_id_fk";
--> statement-breakpoint
ALTER TABLE "workflows" DROP CONSTRAINT "workflows_taskItemId_task_items_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "calendar_triggers_agent_page_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "workflows_task_item_id_idx";--> statement-breakpoint
ALTER TABLE "calendar_triggers" ADD COLUMN "workflowId" text NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_triggers" ADD CONSTRAINT "task_triggers_workflowId_workflows_id_fk" FOREIGN KEY ("workflowId") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_triggers" ADD CONSTRAINT "task_triggers_taskItemId_task_items_id_fk" FOREIGN KEY ("taskItemId") REFERENCES "public"."task_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_triggers_workflow_id_idx" ON "task_triggers" USING btree ("workflowId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_triggers_task_item_id_idx" ON "task_triggers" USING btree ("taskItemId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_triggers_enabled_next_run_idx" ON "task_triggers" USING btree ("isEnabled","nextRunAt");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_triggers" ADD CONSTRAINT "calendar_triggers_workflowId_workflows_id_fk" FOREIGN KEY ("workflowId") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_triggers_workflow_id_idx" ON "calendar_triggers" USING btree ("workflowId");--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "agentPageId";--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "prompt";--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "instructionPageId";--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "contextPageIds";--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "taskItemId";

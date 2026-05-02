-- Workflow Trigger Decomposition (PR 3/3):
--
--   * Introduce workflow_runs as the canonical per-fire audit table — one
--     row per fire across every domain (cron / task / calendar / manual),
--     written at execute-start (status='running') and updated at
--     execute-end (status='success'|'error'|'cancelled', endedAt,
--     durationMs, error, conversationId).
--   * Drop lastRunAt / lastRunStatus / lastRunError / lastRunDurationMs
--     from workflows — per-fire history now lives in workflow_runs.
--   * Drop status / claimedAt / startedAt / completedAt / error /
--     durationMs / conversationId from calendar_triggers — per-fire state
--     also lives in workflow_runs.
--   * Recreate the WorkflowRunStatus enum with the new value set
--     ('running','success','error','cancelled') — drops 'never_run' (a
--     workflow with no runs is now expressed as "no workflow_runs row",
--     not as a sentinel status).
--   * Drop the CalendarTriggerStatus enum entirely — calendar_triggers no
--     longer has a per-fire status column.
--
-- Hard cutover (no nullable bridge column, no dual-write, no backfill).
-- None of these tables hold meaningful prod data yet, so we TRUNCATE
-- calendar_triggers up-front: existing rows reference a per-fire status
-- column that's about to be dropped, and would otherwise re-fire under the
-- new "no workflow_runs row yet" discovery query.

-- Hard-cutover wipe
TRUNCATE TABLE "calendar_triggers";--> statement-breakpoint

-- Drop columns that depend on the enums we're about to drop / recreate
ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "claimedAt";--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "startedAt";--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "completedAt";--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "error";--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "durationMs";--> statement-breakpoint
ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "conversationId";--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "lastRunAt";--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "lastRunStatus";--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "lastRunError";--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "lastRunDurationMs";--> statement-breakpoint

-- Drop the old indexes that referenced dropped columns
DROP INDEX IF EXISTS "calendar_triggers_status_trigger_at_idx";--> statement-breakpoint

-- Drop the old enums (no remaining columns reference them)
DROP TYPE IF EXISTS "WorkflowRunStatus";--> statement-breakpoint
DROP TYPE IF EXISTS "CalendarTriggerStatus";--> statement-breakpoint

-- Create the new enums
CREATE TYPE "public"."WorkflowRunStatus" AS ENUM('running', 'success', 'error', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."WorkflowRunSourceTable" AS ENUM('taskTriggers', 'calendarTriggers', 'cron', 'manual');--> statement-breakpoint

-- Create workflow_runs
CREATE TABLE IF NOT EXISTS "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflowId" text NOT NULL,
	"sourceTable" "WorkflowRunSourceTable" NOT NULL,
	"sourceId" text,
	"triggerAt" timestamp with time zone,
	"startedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"endedAt" timestamp with time zone,
	"status" "WorkflowRunStatus" DEFAULT 'running' NOT NULL,
	"error" text,
	"durationMs" integer,
	"conversationId" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowId_workflows_id_fk" FOREIGN KEY ("workflowId") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_workflow_started_at_idx" ON "workflow_runs" USING btree ("workflowId","startedAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_source_lookup_idx" ON "workflow_runs" USING btree ("sourceTable","sourceId","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_stuck_run_idx" ON "workflow_runs" USING btree ("status","startedAt");--> statement-breakpoint
-- Atomic claim guard: at most one in-flight run per workflow at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_runs_running_claim_idx" ON "workflow_runs" ("workflowId") WHERE "status" = 'running';--> statement-breakpoint

-- Add the calendar_triggers index on triggerAt (replaces status_trigger_at composite)
CREATE INDEX IF NOT EXISTS "calendar_triggers_trigger_at_idx" ON "calendar_triggers" USING btree ("triggerAt");

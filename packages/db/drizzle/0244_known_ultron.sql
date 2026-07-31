CREATE TYPE "public"."WorkflowRunStepStatus" AS ENUM('running', 'success', 'error', 'skipped');--> statement-breakpoint
CREATE TABLE "workflow_run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"runId" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"toolName" text,
	"status" "WorkflowRunStepStatus" DEFAULT 'running' NOT NULL,
	"error" text,
	"durationMs" integer,
	"startedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"endedAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "agentPageId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "steps" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_run_steps" ADD CONSTRAINT "workflow_run_steps_runId_workflow_runs_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_run_steps_run_position_idx" ON "workflow_run_steps" USING btree ("runId","position");
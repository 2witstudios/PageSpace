DO $$ BEGIN
 CREATE TYPE "public"."WorkflowExecutionStatus" AS ENUM('running', 'paused', 'completed', 'failed', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."WorkflowExecutionStepStatus" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_execution_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"workflowExecutionId" text NOT NULL,
	"workflowStepId" text,
	"stepOrder" integer NOT NULL,
	"status" "WorkflowExecutionStepStatus" DEFAULT 'pending' NOT NULL,
	"agentInput" jsonb,
	"agentOutput" jsonb,
	"userInput" jsonb,
	"startedAt" timestamp,
	"completedAt" timestamp,
	"errorMessage" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflowTemplateId" text NOT NULL,
	"userId" text NOT NULL,
	"driveId" text NOT NULL,
	"status" "WorkflowExecutionStatus" DEFAULT 'running' NOT NULL,
	"currentStepOrder" integer,
	"accumulatedContext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"startedAt" timestamp,
	"pausedAt" timestamp,
	"completedAt" timestamp,
	"failedAt" timestamp,
	"errorMessage" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"workflowTemplateId" text NOT NULL,
	"stepOrder" integer NOT NULL,
	"agentId" text NOT NULL,
	"promptTemplate" text NOT NULL,
	"requiresUserInput" boolean DEFAULT false NOT NULL,
	"inputSchema" jsonb,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"driveId" text NOT NULL,
	"createdBy" text NOT NULL,
	"category" text,
	"tags" text[],
	"isPublic" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_execution_steps" ADD CONSTRAINT "workflow_execution_steps_workflowExecutionId_workflow_executions_id_fk" FOREIGN KEY ("workflowExecutionId") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_execution_steps" ADD CONSTRAINT "workflow_execution_steps_workflowStepId_workflow_steps_id_fk" FOREIGN KEY ("workflowStepId") REFERENCES "public"."workflow_steps"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflowTemplateId_workflow_templates_id_fk" FOREIGN KEY ("workflowTemplateId") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflowTemplateId_workflow_templates_id_fk" FOREIGN KEY ("workflowTemplateId") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_execution_steps_execution_id_idx" ON "workflow_execution_steps" USING btree ("workflowExecutionId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_execution_steps_step_id_idx" ON "workflow_execution_steps" USING btree ("workflowStepId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_execution_steps_status_idx" ON "workflow_execution_steps" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_execution_steps_execution_id_order_idx" ON "workflow_execution_steps" USING btree ("workflowExecutionId","stepOrder");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_executions_template_id_idx" ON "workflow_executions" USING btree ("workflowTemplateId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_executions_user_id_idx" ON "workflow_executions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_executions_drive_id_idx" ON "workflow_executions" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_executions_status_idx" ON "workflow_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_executions_user_id_status_idx" ON "workflow_executions" USING btree ("userId","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_executions_drive_id_status_idx" ON "workflow_executions" USING btree ("driveId","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_steps_template_id_idx" ON "workflow_steps" USING btree ("workflowTemplateId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_steps_template_id_order_idx" ON "workflow_steps" USING btree ("workflowTemplateId","stepOrder");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_templates_drive_id_idx" ON "workflow_templates" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_templates_created_by_idx" ON "workflow_templates" USING btree ("createdBy");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_templates_is_public_idx" ON "workflow_templates" USING btree ("isPublic");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_templates_category_idx" ON "workflow_templates" USING btree ("category");
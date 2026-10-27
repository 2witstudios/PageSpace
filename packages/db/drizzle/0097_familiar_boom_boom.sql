ALTER TYPE "WorkflowTriggerType" ADD VALUE 'task_due_date';--> statement-breakpoint
ALTER TYPE "WorkflowTriggerType" ADD VALUE 'task_completion';--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "taskItemId" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "instructionPageId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflows" ADD CONSTRAINT "workflows_taskItemId_task_items_id_fk" FOREIGN KEY ("taskItemId") REFERENCES "public"."task_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflows" ADD CONSTRAINT "workflows_instructionPageId_pages_id_fk" FOREIGN KEY ("instructionPageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_task_item_id_idx" ON "workflows" USING btree ("taskItemId");--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_task_item_trigger_type_key" UNIQUE("taskItemId","triggerType");
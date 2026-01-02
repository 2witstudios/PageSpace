ALTER TABLE "task_items" ADD COLUMN "assigneeAgentId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_items" ADD CONSTRAINT "task_items_assigneeAgentId_pages_id_fk" FOREIGN KEY ("assigneeAgentId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_items_assignee_agent_id_idx" ON "task_items" USING btree ("assigneeAgentId");
CREATE TABLE IF NOT EXISTS "task_assignees" (
	"id" text PRIMARY KEY NOT NULL,
	"taskId" text NOT NULL,
	"userId" text,
	"agentPageId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_assignees_task_user" UNIQUE("taskId","userId"),
	CONSTRAINT "task_assignees_task_agent" UNIQUE("taskId","agentPageId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_status_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"taskListId" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"color" text NOT NULL,
	"group" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_status_configs_task_list_slug" UNIQUE("taskListId","slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_taskId_task_items_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."task_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_agentPageId_pages_id_fk" FOREIGN KEY ("agentPageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_status_configs" ADD CONSTRAINT "task_status_configs_taskListId_task_lists_id_fk" FOREIGN KEY ("taskListId") REFERENCES "public"."task_lists"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_assignees_task_id_idx" ON "task_assignees" USING btree ("taskId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_assignees_user_id_idx" ON "task_assignees" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_assignees_agent_page_id_idx" ON "task_assignees" USING btree ("agentPageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_status_configs_task_list_id_idx" ON "task_status_configs" USING btree ("taskListId");
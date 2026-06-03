CREATE TABLE IF NOT EXISTS "task_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"blockerTaskId" text NOT NULL,
	"blockedTaskId" text NOT NULL,
	"createdById" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_pair" UNIQUE("blockerTaskId","blockedTaskId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_links" (
	"id" text PRIMARY KEY NOT NULL,
	"taskId" text NOT NULL,
	"taskListPageId" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"createdById" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_links_task_list" UNIQUE("taskId","taskListPageId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blockerTaskId_task_items_id_fk" FOREIGN KEY ("blockerTaskId") REFERENCES "public"."task_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blockedTaskId_task_items_id_fk" FOREIGN KEY ("blockedTaskId") REFERENCES "public"."task_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_createdById_users_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_links" ADD CONSTRAINT "task_links_taskId_task_items_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."task_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_links" ADD CONSTRAINT "task_links_taskListPageId_pages_id_fk" FOREIGN KEY ("taskListPageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_links" ADD CONSTRAINT "task_links_createdById_users_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_dependencies_blocker_idx" ON "task_dependencies" USING btree ("blockerTaskId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_dependencies_blocked_idx" ON "task_dependencies" USING btree ("blockedTaskId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_links_task_id_idx" ON "task_links" USING btree ("taskId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_links_list_page_id_idx" ON "task_links" USING btree ("taskListPageId");
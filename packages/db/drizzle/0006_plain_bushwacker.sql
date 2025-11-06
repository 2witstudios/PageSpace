DO $$ BEGIN
 CREATE TYPE "public"."TaskDependencyType" AS ENUM('blocks', 'blocked_by', 'relates_to');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."TaskPriority" AS ENUM('low', 'medium', 'high', 'urgent');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."TaskStatus" AS ENUM('pending', 'in_progress', 'completed', 'blocked', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TYPE "PageType" ADD VALUE 'TASK';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"taskId" text NOT NULL,
	"dependsOnTaskId" text NOT NULL,
	"dependencyType" "TaskDependencyType" DEFAULT 'blocks' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"pageId" text NOT NULL,
	"assigneeId" text,
	"assignerId" text NOT NULL,
	"status" "TaskStatus" DEFAULT 'pending' NOT NULL,
	"priority" "TaskPriority" DEFAULT 'medium' NOT NULL,
	"dueDate" timestamp,
	"startDate" timestamp,
	"completedAt" timestamp,
	"estimatedHours" real,
	"actualHours" real,
	"labels" jsonb DEFAULT '[]'::jsonb,
	"customFields" jsonb DEFAULT '{}'::jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "task_metadata_pageId_unique" UNIQUE("pageId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_taskId_pages_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_dependsOnTaskId_pages_id_fk" FOREIGN KEY ("dependsOnTaskId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_metadata" ADD CONSTRAINT "task_metadata_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_metadata" ADD CONSTRAINT "task_metadata_assigneeId_users_id_fk" FOREIGN KEY ("assigneeId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_metadata" ADD CONSTRAINT "task_metadata_assignerId_users_id_fk" FOREIGN KEY ("assignerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_dependencies_task_id_idx" ON "task_dependencies" USING btree ("taskId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_dependencies_depends_on_task_id_idx" ON "task_dependencies" USING btree ("dependsOnTaskId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_dependencies_task_id_depends_on_task_id_idx" ON "task_dependencies" USING btree ("taskId","dependsOnTaskId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_metadata_page_id_idx" ON "task_metadata" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_metadata_assignee_id_idx" ON "task_metadata" USING btree ("assigneeId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_metadata_assigner_id_idx" ON "task_metadata" USING btree ("assignerId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_metadata_status_idx" ON "task_metadata" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_metadata_due_date_idx" ON "task_metadata" USING btree ("dueDate");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_metadata_priority_idx" ON "task_metadata" USING btree ("priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_metadata_status_priority_idx" ON "task_metadata" USING btree ("status","priority");
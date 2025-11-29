ALTER TYPE "PageType" ADD VALUE 'TASK_LIST';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_items" (
	"id" text PRIMARY KEY NOT NULL,
	"taskListId" text NOT NULL,
	"userId" text NOT NULL,
	"assigneeId" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"dueDate" timestamp,
	"metadata" jsonb,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"pageId" text,
	"conversationId" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_items" ADD CONSTRAINT "task_items_taskListId_task_lists_id_fk" FOREIGN KEY ("taskListId") REFERENCES "public"."task_lists"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_items" ADD CONSTRAINT "task_items_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_items" ADD CONSTRAINT "task_items_assigneeId_users_id_fk" FOREIGN KEY ("assigneeId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_lists" ADD CONSTRAINT "task_lists_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_lists" ADD CONSTRAINT "task_lists_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_items_task_list_id_idx" ON "task_items" USING btree ("taskListId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_items_task_list_status_idx" ON "task_items" USING btree ("taskListId","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_items_assignee_id_idx" ON "task_items" USING btree ("assigneeId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_lists_page_id_idx" ON "task_lists" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_lists_conversation_id_idx" ON "task_lists" USING btree ("conversationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_lists_user_id_idx" ON "task_lists" USING btree ("userId");
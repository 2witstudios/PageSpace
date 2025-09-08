CREATE TABLE IF NOT EXISTS "ai_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"conversationId" text,
	"messageId" text,
	"parentTaskId" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"position" integer DEFAULT 1,
	"metadata" jsonb,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "messageType" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN IF EXISTS "aiSystemPrompt";--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN IF EXISTS "aiDescription";--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN IF EXISTS "aiToolAccess";--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN IF EXISTS "aiModelOverride";
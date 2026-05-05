ALTER TABLE "task_items" ALTER COLUMN "pageId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_items" DROP COLUMN IF EXISTS "title";
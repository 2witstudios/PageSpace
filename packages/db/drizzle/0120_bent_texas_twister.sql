UPDATE "task_items" SET "pageId" = tl."pageId"
FROM "task_lists" tl
WHERE "task_items"."taskListId" = tl."id"
  AND "task_items"."pageId" IS NULL
  AND tl."pageId" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "task_items" WHERE "pageId" IS NULL;
--> statement-breakpoint
ALTER TABLE "task_items" ALTER COLUMN "pageId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_items" DROP COLUMN IF EXISTS "title";

-- 0108: Delete orphaned conversation-scoped task lists
--
-- Before Dec 2025, AI workflows created ephemeral task lists scoped to a
-- conversation ("pageId" IS NULL, "conversationId" IS NOT NULL). These were
-- replaced by page-based task lists. The orphaned rows serve no purpose and
-- accumulate indefinitely. Child task_items are deleted first to satisfy the
-- foreign key constraint. Idempotent: both DELETEs are no-ops if already clean.

DELETE FROM task_items
WHERE "taskListId" IN (
  SELECT id FROM task_lists
  WHERE "pageId" IS NULL AND "conversationId" IS NOT NULL
);
--> statement-breakpoint
DELETE FROM task_lists
WHERE "pageId" IS NULL AND "conversationId" IS NOT NULL;

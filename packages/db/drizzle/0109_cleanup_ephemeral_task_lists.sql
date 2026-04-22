-- 0109: Delete orphaned conversation-scoped task lists
--
-- Before Dec 2025, AI workflows created ephemeral task lists scoped to a
-- conversation (page_id IS NULL, conversation_id IS NOT NULL). These were
-- replaced by page-based task lists. The orphaned rows serve no purpose and
-- accumulate indefinitely. Child task_items are deleted first to satisfy the
-- foreign key constraint. Idempotent: both DELETEs are no-ops if already clean.

DELETE FROM task_items
WHERE task_list_id IN (
  SELECT id FROM task_lists
  WHERE page_id IS NULL AND conversation_id IS NOT NULL
);
--> statement-breakpoint
DELETE FROM task_lists
WHERE page_id IS NULL AND conversation_id IS NOT NULL;

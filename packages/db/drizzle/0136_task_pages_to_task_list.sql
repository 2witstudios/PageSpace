UPDATE pages
SET type = 'TASK_LIST'
WHERE id IN (
  SELECT DISTINCT "pageId" FROM task_items WHERE "pageId" IS NOT NULL
)
AND type = 'DOCUMENT';

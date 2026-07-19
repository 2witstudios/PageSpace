// Lint-rule fixture for the unbounded-findMany ESLint rule (eslint.config.mjs).
// findFirst is inherently single-row and must never be flagged, limit or not.
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { taskItems } from '@pagespace/db/schema/tasks';

export async function getOneTaskItem(pageId: string) {
  return db.query.taskItems.findFirst({
    where: eq(taskItems.pageId, pageId),
  });
}

// Lint-rule fixture for the unbounded-findMany ESLint rule (eslint.config.mjs).
// This call has a `limit` and must pass lint.
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { taskItems } from '@pagespace/db/schema/tasks';

export async function getTaskItemsWithLimit(pageId: string) {
  return db.query.taskItems.findMany({
    where: eq(taskItems.pageId, pageId),
    limit: 50,
  });
}

// Lint-rule fixture for the unbounded-findMany ESLint rule (eslint.config.mjs).
// This call intentionally has no `limit` and must fail lint.
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { taskItems } from '@pagespace/db/schema/tasks';

export async function getAllTaskItemsUnbounded(pageId: string) {
  // Fixture: this is the exact shape the rule must catch — do not "fix" by adding a
  // limit, that would defeat the point of this file.
  // eslint-disable-next-line no-restricted-syntax
  return db.query.taskItems.findMany({
    where: eq(taskItems.pageId, pageId),
  });
}

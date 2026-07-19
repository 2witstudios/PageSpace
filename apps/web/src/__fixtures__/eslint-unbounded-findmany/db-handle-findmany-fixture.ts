// Lint-rule fixtures for the unbounded-findMany ESLint rule (apps/web/eslint.config.mjs).
// Not real application code — these exist only to prove the rule's boundary cases:
// unbounded findMany fails, a top-level `limit` passes, findFirst is exempt entirely.
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { taskItems } from '@pagespace/db/schema/tasks';

export async function getAllTaskItemsUnbounded(pageId: string) {
  // Do not "fix" by adding a limit — that would defeat the point of this function.
  // eslint-disable-next-line no-restricted-syntax
  return db.query.taskItems.findMany({
    where: eq(taskItems.pageId, pageId),
  });
}

export async function getTaskItemsWithLimit(pageId: string) {
  return db.query.taskItems.findMany({
    where: eq(taskItems.pageId, pageId),
    limit: 50,
  });
}

export async function getOneTaskItem(pageId: string) {
  return db.query.taskItems.findFirst({
    where: eq(taskItems.pageId, pageId),
  });
}

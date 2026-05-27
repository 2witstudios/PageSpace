import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskItems } from '@pagespace/db/schema/tasks'

export class SubtasksIncompleteError extends Error {
  readonly code = 'SUBTASKS_INCOMPLETE' as const;
  constructor(
    public readonly pending: number,
    public readonly total: number,
  ) {
    super(`Complete all sub-tasks first (${pending} of ${total} remaining)`);
    this.name = 'SubtasksIncompleteError';
  }
}

/**
 * Throws SubtasksIncompleteError if the task page has any non-trashed child
 * tasks that haven't been completed. Leaf tasks (no children) always pass.
 */
export async function assertSubTasksComplete(taskPageId: string): Promise<void> {
  const subTasks = await db
    .select({ completedAt: taskItems.completedAt })
    .from(taskItems)
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(and(
      eq(pages.parentId, taskPageId),
      eq(pages.isTrashed, false),
    ));

  if (subTasks.length === 0) return;

  const pending = subTasks.filter(t => t.completedAt === null).length;
  if (pending > 0) {
    throw new SubtasksIncompleteError(pending, subTasks.length);
  }
}

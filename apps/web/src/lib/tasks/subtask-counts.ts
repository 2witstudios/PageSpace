import { db } from '@pagespace/db/db'
import { and, count, eq, inArray } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskItems } from '@pagespace/db/schema/tasks'

export interface SubTaskCounts {
  total: number;
  completed: number;
}

/**
 * Batch-count direct, untrashed sub-tasks for a set of task pages, keyed by the
 * parent task's linked page id (sub-tasks are task_items whose page's parentId is
 * that page). Completed = `completedAt IS NOT NULL` — `count(column)` counts only
 * non-null values, so total and completed come from ONE grouped query.
 *
 * Pages absent from the map have no sub-tasks.
 */
export async function getSubTaskCountsByPageId(
  parentPageIds: readonly string[],
): Promise<Map<string, SubTaskCounts>> {
  const result = new Map<string, SubTaskCounts>();
  if (parentPageIds.length === 0) return result;

  const rows = await db
    .select({
      parentId: pages.parentId,
      total: count(),
      completed: count(taskItems.completedAt),
    })
    .from(taskItems)
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(and(inArray(pages.parentId, [...parentPageIds]), eq(pages.isTrashed, false)))
    .groupBy(pages.parentId);

  for (const row of rows) {
    if (row.parentId) {
      result.set(row.parentId, { total: Number(row.total), completed: Number(row.completed) });
    }
  }
  return result;
}

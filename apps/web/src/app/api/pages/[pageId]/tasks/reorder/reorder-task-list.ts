import { and, eq, inArray } from '@pagespace/db/operators'
import type { db } from '@pagespace/db/db'
import { pages } from '@pagespace/db/schema/core'
import { taskItems } from '@pagespace/db/schema/tasks';
import { computeReorderPlan, type ReorderPlan } from '@pagespace/lib/services/reorder';
import { reorderTaskListChildPages, taskListChildPagesWhere } from '@/services/api/task-reorder-service';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Applies a reorder plan — keyed by `task_items.id`, the ids this endpoint's
 * callers submit — to `pages.position`, the single task-ordering rail (#2143).
 * Returns the submitted task ids that were found in scope and written, so the
 * caller can reject unknown ids.
 *
 * Resolution runs before `reorderTaskListChildPages` takes its FOR SHARE scope
 * lock, so a task whose page is trashed in that window resolves here but falls
 * out of scope in the write and is reported as missing — the route then 400s
 * rather than reporting a success it didn't perform.
 */
export async function reorderTaskListChildren(
  tx: Tx,
  pageId: string,
  plan: ReorderPlan,
): Promise<string[]> {
  if (plan.orderedIds.length === 0) {
    return [];
  }

  // Only the submitted ids are materialized here (the route caps them at
  // MAX_REORDER_BATCH), never the whole task list.
  const linkedPages = await tx
    .select({ taskId: taskItems.id, pageId: taskItems.pageId })
    .from(taskItems)
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(and(taskListChildPagesWhere(pageId), inArray(taskItems.id, plan.orderedIds)));

  if (linkedPages.length === 0) {
    return [];
  }

  const taskIdByPageId = new Map(linkedPages.map((row) => [row.pageId, row.taskId]));
  const pagePlan = computeReorderPlan(
    linkedPages.map((row) => ({ id: row.pageId, position: plan.positionById.get(row.taskId) ?? 0 })),
  );

  const lockedPageIds = await reorderTaskListChildPages(tx, pageId, pagePlan);

  return lockedPageIds
    .map((lockedPageId) => taskIdByPageId.get(lockedPageId))
    .filter((taskId): taskId is string => taskId !== undefined);
}

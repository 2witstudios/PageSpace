import { and, eq, inArray } from '@pagespace/db/operators'
import type { db } from '@pagespace/db/db'
import { pages } from '@pagespace/db/schema/core'
import { taskItems } from '@pagespace/db/schema/tasks';
import { lockedBatchReorder, type ReorderPlan } from '@pagespace/lib/services/reorder';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function taskListChildPagesWhere(pageId: string) {
  return and(
    eq(pages.parentId, pageId),
    eq(pages.type, 'TASK_LIST'),
    eq(pages.isTrashed, false),
  );
}

/**
 * Applies a reorder plan to task_items scoped to pageId's TASK_LIST
 * children, inside the caller's transaction. Caller guards the
 * plan.orderedIds.length === 0 case (no-op, no transaction).
 *
 * task_items has no direct FK to its task list — membership is derived via
 * pages that are direct TASK_LIST children of this list's page, the same
 * derivation GET/fetchEnrichedTasks use. That predicate is passed to
 * lockedBatchReorder as a subquery (not a materialized id array) so a large
 * task list doesn't rebind every child id into the write.
 *
 * lockedBatchReorder issues two statements against tx — a locking SELECT,
 * then a batched UPDATE — and under READ COMMITTED each independently
 * re-evaluates that subquery. Locking the scoped pages FOR SHARE first
 * closes the gap: it blocks a concurrent trashPage/move from committing a
 * scope change between the two statements, so both see the same membership.
 * (A page inserted into scope between the two statements — a phantom read,
 * not a modification of an already-scoped row — isn't covered by this lock;
 * closing that needs SERIALIZABLE isolation and is out of scope here.)
 */
export async function reorderTaskListChildren(
  tx: Tx,
  pageId: string,
  plan: ReorderPlan,
): Promise<string[]> {
  await tx.select({ id: pages.id }).from(pages).where(taskListChildPagesWhere(pageId)).for('share');

  return lockedBatchReorder(tx, {
    table: taskItems,
    idColumn: taskItems.id,
    positionColumn: taskItems.position,
    scopeWhere: inArray(taskItems.pageId, tx.select({ id: pages.id }).from(pages).where(taskListChildPagesWhere(pageId))),
    plan,
    touchColumns: [taskItems.updatedAt],
  });
}

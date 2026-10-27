import { and, eq } from '@pagespace/db/operators'
import type { db } from '@pagespace/db/db'
import { pages } from '@pagespace/db/schema/core'
import { lockedBatchReorder, type ReorderPlan } from '@pagespace/lib/services/reorder';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Membership predicate for a task list's tasks. `task_items` has no FK to its
 * task list — a task IS a direct, non-trashed TASK_LIST child page of the list's
 * page, the same derivation the GET route and fetchEnrichedTasks use.
 */
export function taskListChildPagesWhere(pageId: string) {
  return and(
    eq(pages.parentId, pageId),
    eq(pages.type, 'TASK_LIST'),
    eq(pages.isTrashed, false),
  );
}

/**
 * Apply a page-id-keyed reorder plan to `pages.position` for pageId's task
 * children, inside the caller's transaction. Returns the plan ids that were in
 * scope and therefore written.
 *
 * `pages.position` is the single task-ordering rail (#2143). Positions are cast
 * as `real` to match the column — an `::int` cast would truncate the fractional
 * midpoints reorders compute between neighbours.
 *
 * lockedBatchReorder issues two statements against tx — a locking SELECT, then a
 * batched UPDATE — and under READ COMMITTED each independently re-evaluates the
 * scope. Locking the scoped pages FOR SHARE first closes the gap: it blocks a
 * concurrent trashPage/move from committing a scope change between the two
 * statements, so both see the same membership. (A page inserted into scope
 * between the two statements — a phantom read, not a modification of an
 * already-scoped row — isn't covered by this lock; closing that needs
 * SERIALIZABLE isolation and is out of scope here.)
 *
 * This writes positions directly rather than through applyPageMutation, so it
 * bumps no page revisions and logs no per-page activity. That is deliberate for
 * a bulk rail rewrite: a position-only shuffle of a whole list would otherwise
 * emit one revision bump and one activity entry per task. Single-task moves go
 * through applyPageMutation instead (see reorderTaskPeers).
 */
export async function reorderTaskListChildPages(
  tx: Tx,
  pageId: string,
  plan: ReorderPlan,
): Promise<string[]> {
  if (plan.orderedIds.length === 0) {
    return [];
  }

  await tx.select({ id: pages.id }).from(pages).where(taskListChildPagesWhere(pageId)).for('share');

  return lockedBatchReorder(tx, {
    table: pages,
    idColumn: pages.id,
    positionColumn: pages.position,
    scopeWhere: taskListChildPagesWhere(pageId)!,
    plan,
    touchColumns: [pages.updatedAt],
    positionType: 'real',
  });
}
